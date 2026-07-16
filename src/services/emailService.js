import nodemailer from 'nodemailer';
import { promises as dns } from 'node:dns';
import pool from '../db/pool.js';
import { getValidGoogleTokens } from '../utils/googleAuth.js';
import { getValidMicrosoftToken } from '../utils/microsoftAuth.js';
import { buildGmailRawMime, parseReplyToAddress } from '../utils/mimeMessage.js';
import fetch from 'node-fetch';

// Nodemailer per-operation timeouts — kept short so the total
// completes well within cdmon/nginx's ~10–15 s proxy window.
const SMTP_TIMEOUTS = {
    connectionTimeout: 4000,   // TCP connect
    greetingTimeout:   4000,   // server banner
    socketTimeout:     6000,   // idle socket
    dnsTimeout:        3000,
};

// Hard ceiling for the entire test (verify + optional send).
// Must be shorter than the hosting proxy timeout (~10-15 s on cdmon).
const SMTP_TEST_HARD_LIMIT_MS = 12000;

const SMTP_PROVIDER_PRESETS = [
    {
        id: 'gmail',
        label: 'Google Workspace / Gmail',
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        mxPattern: /(google\.com|googlemail\.com)$/i,
        authHint:
            'Use your full Gmail address and a Google App Password. If this mailbox is already on Google Workspace, Google OAuth is easier than SMTP.',
    },
    {
        id: 'outlook',
        label: 'Microsoft 365 / Outlook',
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        mxPattern: /(outlook\.com|protection\.outlook\.com)$/i,
        authHint:
            'Use your full mailbox address and password. If your Microsoft account uses MFA, create an app password if your tenant allows it.',
    },
    {
        id: 'zoho',
        label: 'Zoho Mail',
        host: 'smtp.zoho.com',
        port: 465,
        secure: true,
        mxPattern: /zoho\.(com|eu|in|com\.au)$/i,
        authHint: 'Use your full Zoho mailbox address and mailbox password.',
    },
    {
        id: 'privateemail',
        label: 'Namecheap Private Email',
        host: 'mail.privateemail.com',
        port: 587,
        secure: false,
        mxPattern: /privateemail\.com$/i,
        authHint: 'Use your full mailbox address and mailbox password.',
    },
    {
        id: 'hostinger',
        label: 'Hostinger Email',
        host: 'smtp.hostinger.com',
        port: 465,
        secure: true,
        mxPattern: /hostinger\.io$/i,
        authHint: 'Use your full mailbox address and mailbox password.',
    },
    {
        id: 'titan',
        label: 'Titan Email',
        host: 'smtp.titan.email',
        port: 465,
        secure: true,
        mxPattern: /titan\.email$/i,
        authHint: 'Use your full mailbox address and mailbox password.',
    },
];

function normalizeSmtpHost(host) {
    return String(host || '')
        .trim()
        .replace(/^\w+:\/\//i, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '')
        .trim()
        .toLowerCase();
}

function normalizeSmtpConfig(config = {}) {
    const host = normalizeSmtpHost(config.host);
    const parsedPort = Number.parseInt(String(config.port ?? '').trim(), 10);
    const secure =
        config.secure === true ||
        config.secure === 'true' ||
        config.secure === 1 ||
        config.secure === '1';
    return {
        host,
        port: Number.isFinite(parsedPort) ? parsedPort : secure ? 465 : 587,
        secure,
        auth_user: String(config.auth_user || '').trim(),
        auth_pass: String(config.auth_pass || ''),
    };
}

function findProviderByHost(host) {
    const normalizedHost = normalizeSmtpHost(host);
    return SMTP_PROVIDER_PRESETS.find((provider) => provider.host === normalizedHost) || null;
}

function findProviderByMx(exchange) {
    const normalizedExchange = String(exchange || '').trim().toLowerCase();
    return SMTP_PROVIDER_PRESETS.find((provider) => provider.mxPattern.test(normalizedExchange)) || null;
}

function buildSmtpTransportOptions(config) {
    const normalized = normalizeSmtpConfig(config);
    return {
        host: normalized.host,
        port: normalized.port,
        secure: normalized.secure,
        auth: {
            user: normalized.auth_user,
            pass: normalized.auth_pass,
        },
        tls: { rejectUnauthorized: false },
        ...SMTP_TIMEOUTS,
    };
}

function getSecurityHint(config) {
    if (config.port === 465 && !config.secure) {
        return 'Port 465 usually needs SSL/TLS turned on.';
    }
    if (config.port === 587 && config.secure) {
        return 'Port 587 usually uses Standard / STARTTLS instead of SSL/TLS.';
    }
    return null;
}

function mapSmtpError(error, config) {
    const rawMessage = String(error?.message || 'Unknown SMTP error');
    const lowerMessage = rawMessage.toLowerCase();
    const provider = findProviderByHost(config.host);
    const portHint =
        config.secure
            ? 'If this keeps failing, try Standard security on port 587.'
            : 'If this keeps failing, try SSL/TLS on port 465.';

    if (
        error?.code === 'EAUTH' ||
        /invalid login|username and password not accepted|authentication unsuccessful|app password|534-5\.7\.9|535/i.test(rawMessage)
    ) {
        return {
            success: false,
            code: 'smtp_auth_failed',
            status: 400,
            message: 'Login failed. Check the mailbox password.',
            hint:
                provider?.authHint ||
                'If your provider uses 2-step verification, use an app password instead of your normal password.',
        };
    }

    if (error?.code === 'ENOTFOUND' || /getaddrinfo|not found/i.test(rawMessage)) {
        return {
            success: false,
            code: 'smtp_host_not_found',
            status: 400,
            message: 'Mail server address was not found.',
            hint: 'Check the SMTP host spelling or use provider auto-detect.',
        };
    }

    if (
        error?.code === 'ETIMEDOUT' ||
        error?.code === 'ESOCKET' ||
        error?.code === 'ECONNECTION' ||
        /timed out|timeout|greeting/i.test(lowerMessage)
    ) {
        return {
            success: false,
            code: 'smtp_timeout',
            status: 504,
            message: 'The mail server did not respond in time.',
            hint: `${portHint} Some hosting providers also block outbound SMTP until it is enabled.`,
        };
    }

    if (
        /ssl routines|wrong version number|certificate|tls|starttls|handshake/i.test(lowerMessage) ||
        error?.code === 'EPROTOCOL'
    ) {
        return {
            success: false,
            code: 'smtp_tls_mismatch',
            status: 400,
            message: 'Security settings do not match this mail server.',
            hint: 'Try port 587 with Standard security or port 465 with SSL/TLS.',
        };
    }

    if (
        error?.code === 'EENVELOPE' ||
        /sender address rejected|mail from command failed|550|553|from address/i.test(lowerMessage)
    ) {
        return {
            success: false,
            code: 'smtp_sender_rejected',
            status: 400,
            message: 'The login worked, but the sender address was rejected.',
            hint: 'Use a From email that belongs to this mailbox or verified domain.',
        };
    }

    return {
        success: false,
        code: 'smtp_connection_failed',
        status: 400,
        message: 'Could not connect to the mail server.',
        hint: getSecurityHint(config) || 'Check the host, port, security mode, and mailbox credentials.',
    };
}

function formatSmtpFrom(config, fromEmail, fromName) {
    const finalEmail = String(fromEmail || config.auth_user || '').trim();
    const finalName = String(fromName || '').trim();
    if (!finalEmail) {
        return undefined;
    }
    return finalName ? `"${finalName.replace(/"/g, '\\"')}" <${finalEmail}>` : finalEmail;
}

export async function detectSmtpProvider(emailAddress) {
    const email = String(emailAddress || '').trim().toLowerCase();
    const domain = email.split('@')[1];

    if (!domain) {
        return {
            success: false,
            status: 400,
            code: 'smtp_email_required',
            message: 'Enter a mailbox email address first.',
        };
    }

    const fallback = {
        providerId: 'cpanel',
        providerLabel: 'Custom domain mailbox',
        host: `mail.${domain}`,
        port: 587,
        secure: false,
        confidence: 'low',
        hint: 'This is a best guess. If your host shows a different SMTP server in its mail panel, use that value instead.',
    };

    try {
        const mxRecords = await dns.resolveMx(domain);
        const primaryMx = [...mxRecords].sort((a, b) => a.priority - b.priority)[0];
        const provider = findProviderByMx(primaryMx?.exchange);

        if (!provider) {
            return {
                success: true,
                message: `We could not match ${domain} to a known provider, so we filled a common custom-domain default.`,
                config: fallback,
                mxHost: primaryMx?.exchange || null,
            };
        }

        return {
            success: true,
            message: `Detected ${provider.label}. Server settings were filled automatically.`,
            config: {
                providerId: provider.id,
                providerLabel: provider.label,
                host: provider.host,
                port: provider.port,
                secure: provider.secure,
                confidence: 'high',
                hint: provider.authHint,
            },
            mxHost: primaryMx?.exchange || null,
        };
    } catch {
        return {
            success: true,
            message: `We could not read MX records for ${domain}, so we filled a common custom-domain default.`,
            config: fallback,
            mxHost: null,
        };
    }
}

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
            try {
                const config = smtpRes.rows[0];
                console.log(`[EmailService][${Date.now() - startTime}ms] Using Custom SMTP (${config.from_email})`);
                
                const transporter = nodemailer.createTransport(buildSmtpTransportOptions(config));

                const finalFrom = config.from_name 
                    ? `"${config.from_name}" <${config.from_email}>` 
                    : config.from_email;

                const sendOptions = { ...mailOptions, from: mailOptions.from || finalFrom };
                const info = await transporter.sendMail(sendOptions);
                console.log(`[EmailService][${Date.now() - startTime}ms] ✅ Custom SMTP sent: ${info.messageId}`);
                return { success: true, messageId: info.messageId, provider: 'smtp' };
            } catch (smtpErr) {
                console.warn('[EmailService] Custom SMTP failed, trying integrations:', smtpErr.message);
            }
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

                    const graphAttachments = (mailOptions.attachments || []).map((att) => ({
                        '@odata.type': '#microsoft.graph.fileAttachment',
                        name: att.filename,
                        contentType: att.contentType || 'application/octet-stream',
                        contentBytes: Buffer.isBuffer(att.content)
                            ? att.content.toString('base64')
                            : Buffer.from(att.content).toString('base64'),
                    }));
                    if (graphAttachments.length > 0) {
                        graphMessage.attachments = graphAttachments;
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
            try {
                const { access_token: googleAccessToken } = await getValidGoogleTokens(userId);
                const googleFrom = integrations.google.email;
                if (googleAccessToken && googleFrom) {
                    console.log(`[EmailService][${Date.now() - startTime}ms] Using Gmail API (Direct Fetch)`);

                    const encodedMail = await buildGmailRawMime(mailOptions, googleFrom);

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
            } catch (googleErr) {
                console.warn('[EmailService] Google Integration failed, trying fallback:', googleErr.message);
            }
        }

        // 4. Try Platform Gmail Fallback (SMTP using EMAIL_USER and EMAIL_PASS)
        const platformEmail = process.env.EMAIL_USER?.trim();
        const platformPass = process.env.EMAIL_PASS?.replace(/\s+/g, '');
        if (platformEmail && platformPass) {
            console.log(`[EmailService][${Date.now() - startTime}ms] Using Platform Gmail Fallback SMTP (${platformEmail})`);
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: platformEmail,
                    pass: platformPass,
                },
                ...SMTP_TIMEOUTS,
            });

            // Fetch business owner name/email for From and Reply-To headers
            const userRes = await pool.query('SELECT name, company_name, email FROM users WHERE id = $1', [userId]);
            const user = userRes.rows[0] || {};
            const displayName = user.company_name || user.name || 'Our Team';
            
            const finalFrom = `"${displayName.replace(/"/g, '\\"')}" <${platformEmail}>`;
            const finalReplyTo = mailOptions.replyTo || user.email || platformEmail;

            const sendOptions = {
                ...mailOptions,
                from: mailOptions.from || finalFrom,
                replyTo: finalReplyTo,
            };
            const info = await transporter.sendMail(sendOptions);
            console.log(`[EmailService][${Date.now() - startTime}ms] ✅ Platform Gmail Fallback sent: ${info.messageId}`);
            return { success: true, messageId: info.messageId, provider: 'platform_gmail_fallback' };
        }

        throw new Error(
            'No outbound email is configured for this workspace, and platform fallback failed. Link the Gmail you use on your account — ' +
                'open Dashboard → Integrations → Connect Google — or connect Microsoft Outlook, ' +
                'or add SMTP. You can change this anytime in Integrations or SMTP settings.'
        );
    } catch (error) {
        console.error(`[EmailService][${Date.now() - startTime}ms] ❌ Dispatch Error:`, error.message);
        throw error;
    }
};

/**
 * Validates SMTP connection and sends a test email.
 * Wrapped in a hard 12-second deadline so it always responds before
 * the hosting reverse-proxy (cdmon nginx ~10-15 s) kills the connection.
 */
export const testSmtpConnection = async (config) => {
    const timeoutPayload = {
        success: false,
        code: 'smtp_timeout',
        status: 504,
        message: 'The mail server did not respond in time.',
        hint: config.secure
            ? 'Try Standard security on port 587 instead. Make sure outbound SMTP is enabled in cPanel → Email → SMTP Restrictions.'
            : 'Try SSL/TLS on port 465 instead. Make sure outbound SMTP is enabled in cPanel → Email → SMTP Restrictions.',
    };

    return Promise.race([
        _doSmtpTest(config),
        new Promise((resolve) => setTimeout(() => resolve(timeoutPayload), SMTP_TEST_HARD_LIMIT_MS)),
    ]);
};

async function _doSmtpTest(config) {
    const normalizedConfig = normalizeSmtpConfig(config);
    const transporter = nodemailer.createTransport(buildSmtpTransportOptions(normalizedConfig));

    try {
        // Phase 1: verify credentials & connection (fast — 4 s timeout)
        await transporter.verify();

        // Phase 2: send test email — give it its own short window
        const recipient = String(config.testRecipient || normalizedConfig.auth_user).trim();
        if (recipient) {
            try {
                const info = await Promise.race([
                    transporter.sendMail({
                        from: formatSmtpFrom(normalizedConfig, config.from_email, config.from_name),
                        to: recipient,
                        subject: 'SMTP test email from Equipo Experto',
                        text:
                            `Your mailbox is connected correctly.\n\n` +
                            `Server: ${normalizedConfig.host}:${normalizedConfig.port}\n` +
                            `Security: ${normalizedConfig.secure ? 'SSL/TLS' : 'STARTTLS / Standard'}\n\n` +
                            `You can now send emails from Equipo Experto using this mailbox.`,
                        html:
                            `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">` +
                            `<h2 style="margin:0 0 12px">SMTP connection verified</h2>` +
                            `<p style="margin:0 0 12px">Your mailbox is connected correctly and can now send emails from Equipo Experto.</p>` +
                            `<ul style="margin:0 0 16px;padding-left:20px">` +
                            `<li><strong>Server:</strong> ${normalizedConfig.host}:${normalizedConfig.port}</li>` +
                            `<li><strong>Security:</strong> ${normalizedConfig.secure ? 'SSL/TLS' : 'STARTTLS / Standard'}</li>` +
                            `</ul>` +
                            `<p style="margin:0">If you did not request this test, you can ignore this email.</p>` +
                            `</div>`,
                    }),
                    // If sending takes too long, skip it but still report success
                    new Promise((resolve) =>
                        setTimeout(() => resolve(null), 5000)
                    ),
                ]);

                return {
                    success: true,
                    messageId: info?.messageId ?? null,
                    message: info
                        ? `Connection verified. Test email sent to ${recipient}.`
                        : `Connection verified successfully. (Test email delivery was slow — check your inbox in a moment.)`,
                    hint: getSecurityHint(normalizedConfig),
                };
            } catch (sendErr) {
                // verify() passed but sendMail failed — still a partial success
                return {
                    success: true,
                    message: `SMTP login verified. However, sending the test email failed: ${sendErr.message}`,
                    hint: getSecurityHint(normalizedConfig) || 'Check that the From address belongs to this mailbox.',
                };
            }
        }

        return {
            success: true,
            message: 'SMTP login verified.',
            hint: getSecurityHint(normalizedConfig),
        };
    } catch (error) {
        return mapSmtpError(error, normalizedConfig);
    } finally {
        transporter.close();
    }
}
