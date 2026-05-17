import nodemailer from 'nodemailer';
import pool from '../db/pool.js';
import { getValidGoogleTokens } from '../utils/googleAuth.js';
import { getValidMicrosoftToken } from '../utils/microsoftAuth.js';
import { buildGmailRawMime, parseReplyToAddress } from '../utils/mimeMessage.js';
import fetch from 'node-fetch';

function parseIntegrationMetadata(raw) {
    if (!raw) return {};
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }
    return raw;
}

function integrationEmail(provider, meta, accountId) {
    if (meta?.email) return meta.email;
    if (provider === 'google') {
        const m = /^gmail:(.+)$/i.exec(accountId || '');
        if (m) return m[1];
    }
    return null;
}

/**
 * Service to handle dynamic email dispatching.
 * Prioritizes:
 * 1. User's custom SMTP settings
 * 2. User's Microsoft Integration (Email)
 * 3. User's Google Integration (OAuth Gmail — same inbox they connect under Integrations)
 *
 * No shared server Gmail fallback — users must link Google (or Microsoft/SMTP) to send as themselves.
 */
/**
 * @param {string} userId
 * @param {import('nodemailer').SendMailOptions} mailOptions
 * @param {{ integrationsOnly?: boolean }} [options] — skip per-user SMTP (e.g. contact form uses Gmail API only)
 */
export const sendDynamicEmail = async (userId, mailOptions, options = {}) => {
    const startTime = Date.now();
    try {
        console.log(`[EmailService][${startTime}] 🚀 Starting dispatch for user ${userId} to ${mailOptions.to}`);
        
        // 1. Fetch All Integration Settings in one go
        const [smtpRes, integrationsRes] = await Promise.all([
            options.integrationsOnly
                ? Promise.resolve({ rows: [] })
                : pool.query('SELECT * FROM smtp_settings WHERE user_id = $1 AND is_active = true', [userId]),
            pool.query(
                'SELECT provider, metadata, account_id FROM integrations WHERE user_id = $1',
                [userId],
            ),
        ]);

        const integrations = integrationsRes.rows.reduce((acc, curr) => {
            const meta = parseIntegrationMetadata(curr.metadata);
            acc[curr.provider] = {
                ...meta,
                email: integrationEmail(curr.provider, meta, curr.account_id),
            };
            return acc;
        }, {});

        // 1. Try Custom SMTP
        if (!options.integrationsOnly && smtpRes.rows.length > 0) {
            const config = smtpRes.rows[0];
            console.log(`[EmailService][${Date.now() - startTime}ms] Using Custom SMTP (${config.from_email})`);
            
            const transporter = nodemailer.createTransport({
                host: config.host,
                port: config.port,
                secure: config.secure, 
                auth: {
                    user: config.auth_user,
                    pass: config.auth_pass,
                },
                tls: { rejectUnauthorized: false }
            });

            const finalFrom = config.from_name 
                ? `"${config.from_name}" <${config.from_email}>` 
                : config.from_email;

            const options = { ...mailOptions, from: mailOptions.from || finalFrom };
            const info = await transporter.sendMail(options);
            console.log(`[EmailService][${Date.now() - startTime}ms] ✅ Custom SMTP sent: ${info.messageId}`);
            return { success: true, messageId: info.messageId, provider: 'smtp' };
        }

        // 2. Try Microsoft Integration (fall through to Google on failure)
        if (integrations.microsoft?.email) {
            try {
                const microsoftToken = await getValidMicrosoftToken(userId);
                if (microsoftToken) {
                    console.log(`[EmailService][${Date.now() - startTime}ms] Using Microsoft Graph`);

                    const replyTo = parseReplyToAddress(mailOptions.replyTo);
                    const graphMessage = {
                        subject: mailOptions.subject,
                        body: {
                            contentType: mailOptions.html ? 'HTML' : 'Text',
                            content: mailOptions.html || mailOptions.text,
                        },
                        toRecipients: [{ emailAddress: { address: mailOptions.to } }],
                    };
                    if (replyTo) {
                        graphMessage.replyTo = [
                            { emailAddress: { address: replyTo.address, name: replyTo.name } },
                        ];
                    }

                    const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${microsoftToken}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            message: graphMessage,
                            saveToSentItems: 'true',
                        }),
                    });

                    if (response.ok) {
                        console.log(`[EmailService][${Date.now() - startTime}ms] ✅ Microsoft Graph sent`);
                        return { success: true, provider: 'microsoft' };
                    }

                    const errData = await response.json().catch(() => ({}));
                    console.warn('[EmailService] Microsoft Graph failed, trying Gmail:', errData);
                }
            } catch (msErr) {
                console.warn('[EmailService] Microsoft send error, trying Gmail:', msErr.message);
            }
        }

        // 3. Try Google Integration (Gmail API via Fetch for speed)
        if (integrations.google) {
            const { access_token: googleAccessToken } = await getValidGoogleTokens(userId);
            const googleFrom = integrations.google.email;
            if (googleAccessToken && googleFrom) {
                console.log(`[EmailService][${Date.now() - startTime}ms] Using Gmail API (Direct Fetch)`);

                const encodedMail = buildGmailRawMime(mailOptions, googleFrom);

                const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${googleAccessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ raw: encodedMail })
                });

                if (response.ok) {
                    const data = await response.json();
                    console.log(`[EmailService][${Date.now() - startTime}ms] ✅ Gmail API sent: ${data.id}`);
                    return { success: true, messageId: data.id, provider: 'google' };
                } else {
                    const errData = await response.json();
                    console.error('[EmailService] ❌ Gmail API Failed:', errData);
                    
                    // Specific error handling for UX
                    if (errData.error?.code === 401) {
                        throw new Error('Gmail access expired. Please reconnect your account in Integrations.');
                    }
                    if (errData.error?.code === 403) {
                        throw new Error('Gmail permission denied. Make sure you granted "Send" permissions.');
                    }
                    if (errData.error?.code === 429) {
                        throw new Error('Gmail rate limit reached. Please try again in a few minutes.');
                    }
                    if (errData.error?.message?.includes('Invalid To header')) {
                        throw new Error('Invalid recipient email address.');
                    }
                    
                    throw new Error(`Gmail API Error: ${errData.error?.message || 'Unknown error'}`);
                }
            }
        }

        throw new Error(
            'No outbound email is configured for this workspace. Link the Gmail you use on your account — ' +
                'open Dashboard → Integrations → Connect Google — or connect Microsoft Outlook, ' +
                'or add SMTP. You can change this anytime in Integrations or SMTP settings.'
        );
    } catch (error) {
        console.error(`[EmailService][${Date.now() - startTime}ms] ❌ Dispatch Error:`, error.message);
        throw error;
    }
};

/**
 * Validates SMTP connection
 */
export const testSmtpConnection = async (config) => {
    const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
            user: config.auth_user,
            pass: config.auth_pass,
        },
        timeout: 10000 // 10s timeout
    });

    try {
        await transporter.verify();
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
};
