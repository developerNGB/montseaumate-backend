import nodemailer from 'nodemailer';
import pool from '../db/pool.js';
import { getValidGoogleTokens } from '../utils/googleAuth.js';
import { getValidMicrosoftToken } from '../utils/microsoftAuth.js';
import fetch from 'node-fetch';

/**
 * Service to handle dynamic email dispatching.
 * Prioritizes:
 * 1. User's custom SMTP settings
 * 2. User's Microsoft Integration (Email)
 * 3. User's Google Integration (Email)
 * 4. System fallback Gmail
 */
export const sendDynamicEmail = async (userId, mailOptions) => {
    const startTime = Date.now();
    try {
        console.log(`[EmailService][${startTime}] 🚀 Starting dispatch for user ${userId} to ${mailOptions.to}`);
        
        // 1. Fetch All Integration Settings in one go
        const [smtpRes, integrationsRes] = await Promise.all([
            pool.query('SELECT * FROM smtp_settings WHERE user_id = $1 AND is_active = true', [userId]),
            pool.query('SELECT provider, metadata FROM integrations WHERE user_id = $1', [userId])
        ]);

        const integrations = integrationsRes.rows.reduce((acc, curr) => {
            acc[curr.provider] = curr.metadata || {};
            return acc;
        }, {});

        // 1. Try Custom SMTP
        if (smtpRes.rows.length > 0) {
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

        // 2. Try Microsoft Integration
        if (integrations.microsoft) {
            const microsoftToken = await getValidMicrosoftToken(userId);
            if (microsoftToken && integrations.microsoft.email) {
                console.log(`[EmailService][${Date.now() - startTime}ms] Using Microsoft Graph`);
                
                const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${microsoftToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: {
                            subject: mailOptions.subject,
                            body: {
                                contentType: mailOptions.html ? 'HTML' : 'Text',
                                content: mailOptions.html || mailOptions.text
                            },
                            toRecipients: [{
                                emailAddress: { address: mailOptions.to }
                            }]
                        },
                        saveToSentItems: 'true'
                    })
                });

                if (response.ok) {
                    console.log(`[EmailService][${Date.now() - startTime}ms] ✅ Microsoft Graph sent`);
                    return { success: true, provider: 'microsoft' };
                } else {
                    const errData = await response.json();
                    console.error('[EmailService] ❌ Microsoft Graph Failed:', errData);
                    
                    if (errData.error?.code === 'InvalidAuthenticationToken') {
                        throw new Error('Microsoft access expired. Please reconnect in Integrations.');
                    }
                    if (errData.error?.code === 'ErrorInvalidRecipients') {
                        throw new Error('Invalid recipient email address.');
                    }
                    throw new Error(`Microsoft Error: ${errData.error?.message || 'Unknown error'}`);
                }
            }
        }

        // 3. Try Google Integration (Gmail API via Fetch for speed)
        if (integrations.google) {
            const { access_token: googleAccessToken } = await getValidGoogleTokens(userId);
            if (googleAccessToken && integrations.google.email) {
                console.log(`[EmailService][${Date.now() - startTime}ms] Using Gmail API (Direct Fetch)`);
                
                // Construct a simple MIME message for Gmail API
                const boundary = 'foo_bar_baz';
                const subject = mailOptions.subject;
                const to = mailOptions.to;
                const from = integrations.google.email;
                const body = mailOptions.html || mailOptions.text;
                const contentType = mailOptions.html ? 'text/html' : 'text/plain';

                const str = [
                    `MIME-Version: 1.0\n`,
                    `To: ${to}\n`,
                    `From: ${from}\n`,
                    `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=\n`,
                    `Content-Type: ${contentType}; charset="UTF-8"\n`,
                    `Content-Transfer-Encoding: 7bit\n\n`,
                    body
                ].join('');

                const encodedMail = Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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

        // 4. Default System Fallback
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            console.log(`[EmailService][${Date.now() - startTime}ms] Using System Gmail (${process.env.EMAIL_USER})`);
            
            const systemTransporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                }
            });

            // Skip verification in production for speed, rely on try/catch
            const options = { ...mailOptions, from: mailOptions.from || process.env.EMAIL_USER };
            const info = await systemTransporter.sendMail(options);
            console.log(`[EmailService][${Date.now() - startTime}ms] ✅ System Gmail sent: ${info.messageId}`);
            return { success: true, messageId: info.messageId, provider: 'system' };
        }

        throw new Error('No email provider available');

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
