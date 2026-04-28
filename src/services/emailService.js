import nodemailer from 'nodemailer';
import pool from '../db/pool.js';
import { getValidGoogleToken, getValidGoogleTokens } from '../utils/googleAuth.js';
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
    try {
        console.log(`[EmailService] Starting dispatch for user ${userId} to ${mailOptions.to}`);
        
        // 1. Fetch User SMTP Settings
        const smtpRes = await pool.query(
            `SELECT * FROM smtp_settings WHERE user_id = $1 AND is_active = true`,
            [userId]
        );

        if (smtpRes.rows.length > 0) {
            const config = smtpRes.rows[0];
            console.log(`[EmailService] Using Custom SMTP for user ${userId} (${config.from_email})`);
            
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
            console.log(`[EmailService] ✅ Custom SMTP sent: ${info.messageId}`);
            return { success: true, messageId: info.messageId, provider: 'smtp' };
        } else {
            console.log(`[EmailService] No Custom SMTP configured for user ${userId}`);
        }

        // 2. Try Microsoft Integration
        const microsoftToken = await getValidMicrosoftToken(userId);
        if (microsoftToken) {
            console.log(`[EmailService] Using Microsoft Graph for user ${userId}`);
            
            // Get user email from metadata
            const intRes = await pool.query('SELECT metadata FROM integrations WHERE user_id = $1 AND provider = $2', [userId, 'microsoft']);
            const meta = intRes.rows[0]?.metadata || {};
            const senderEmail = meta.email;

            if (senderEmail) {
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
                    console.log(`[EmailService] ✅ Microsoft Graph sent to ${mailOptions.to}`);
                    return { success: true, provider: 'microsoft' };
                } else {
                    const errData = await response.json();
                    console.error('[EmailService] ❌ Microsoft Graph Send Failed:', errData);
                    // Fall through to next provider if allowed, or throw
                }
            } else {
                console.log(`[EmailService] Microsoft integration found but no sender email`);
            }
        } else {
            console.log(`[EmailService] No Microsoft integration found for user ${userId}`);
        }

        // 3. Try Google Integration
        const { access_token: googleAccessToken, refresh_token: googleRefreshToken } = await getValidGoogleTokens(userId);
        if (googleAccessToken && googleRefreshToken) {
            console.log(`[EmailService] Using Google OAuth for user ${userId}`);
            
            const intRes = await pool.query('SELECT metadata FROM integrations WHERE user_id = $1 AND provider = $2', [userId, 'google']);
            const meta = intRes.rows[0]?.metadata || {};
            const senderEmail = meta.email;

            if (senderEmail) {
                const transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: {
                        type: 'OAuth2',
                        user: senderEmail,
                        clientId: process.env.GOOGLE_CLIENT_ID,
                        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                        refreshToken: googleRefreshToken,
                        accessToken: googleAccessToken
                    }
                });

                const options = { ...mailOptions, from: senderEmail };
                const info = await transporter.sendMail(options);
                console.log(`[EmailService] ✅ Google OAuth sent to ${mailOptions.to}: ${info.messageId}`);
                return { success: true, messageId: info.messageId, provider: 'google' };
            } else {
                console.log(`[EmailService] Google OAuth available but no sender email found in metadata`);
            }
        } else {
            console.log(`[EmailService] No Google OAuth tokens found for user ${userId}`);
        }

        // 4. Default System Fallback
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            console.error('[EmailService] ❌ System fallback not configured - EMAIL_USER or EMAIL_PASS missing');
            throw new Error('No email provider configured and system fallback not available');
        }
        
        console.log(`[EmailService] Using System Gmail for user ${userId} (${process.env.EMAIL_USER})`);
        const systemTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        // Verify connection before sending
        try {
            await systemTransporter.verify();
            console.log('[EmailService] System Gmail connection verified');
        } catch (verifyErr) {
            console.error('[EmailService] ❌ System Gmail connection failed:', verifyErr.message);
            throw verifyErr;
        }

        const options = { ...mailOptions, from: mailOptions.from || process.env.EMAIL_USER };
        const info = await systemTransporter.sendMail(options);
        console.log(`[EmailService] ✅ System Gmail sent: ${info.messageId}`);
        return { success: true, messageId: info.messageId, provider: 'system' };

    } catch (error) {
        console.error('[EmailService] ❌ Dispatch Error:', error.message);
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
