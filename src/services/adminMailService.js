import pool from '../db/pool.js';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load env vars explicitly to ensure they are available
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const SMTP_TIMEOUT_MS = 5000;

// Helper to check if a password is a placeholder
function isPlaceholderSmtpPass(pass) {
    if (!pass) return true;
    const lower = pass.toLowerCase();
    return (
        lower.includes('your_') ||
        lower.includes('your-') ||
        lower.includes('changeme') ||
        lower.includes('placeholder') ||
        lower.includes('password_here') ||
        lower === 'your_cdmon_password_here'
    );
}

/**
 * Sends a notification email to the admin inbox defined in CONTACT_FORM_TO.
 * Guarantees that the email is sent ONLY from the configured admin email (equipoexpertoia@gmail.com).
 * Uses env-configured Gmail SMTP on port 587 as the primary strategy, with fallbacks.
 */
export async function sendAdminNotification({ subject, text, html, replyTo }) {
    const adminEmail = (process.env.CONTACT_FORM_TO || 'equipoexpertoia@gmail.com').trim().toLowerCase();
    const errors = [];

    // --- STRATEGY 1: Try env Gmail SMTP on port 587 with App Password (STARTTLS) ---
    try {
        const gmailUser = (process.env.EMAIL_USER || 'equipoexpertoia@gmail.com').trim();
        const gmailPass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');

        if (gmailUser && gmailPass) {
            if (gmailUser.toLowerCase().trim() !== adminEmail) {
                throw new Error(`Gmail user ${gmailUser} does not match adminEmail ${adminEmail}`);
            }

            console.log(`[AdminMailService] Attempting env Gmail SMTP:587 send via ${gmailUser}`);
            const transporter587 = nodemailer.createTransport({
                host: 'smtp.gmail.com',
                port: 587,
                secure: false,
                requireTLS: true,
                auth: { user: gmailUser, pass: gmailPass },
                connectionTimeout: SMTP_TIMEOUT_MS,
                greetingTimeout: SMTP_TIMEOUT_MS,
                socketTimeout: SMTP_TIMEOUT_MS,
            });
            const info = await transporter587.sendMail({
                from: `"Equipo Experto Notification" <${gmailUser}>`,
                to: adminEmail,
                replyTo: replyTo || undefined,
                subject,
                text,
                html,
            });
            console.log(`[AdminMailService] ✅ Sent via env Gmail SMTP:587: ${info.messageId}`);
            return { success: true, messageId: info.messageId, provider: 'env_gmail_smtp_587' };
        }
    } catch (err587) {
        console.warn(`[AdminMailService] Env Gmail SMTP:587 failed: ${err587.message}`);
        errors.push(`env_gmail_smtp_587:${err587.message}`);
    }

    // --- STRATEGY 2: Try env Gmail SMTP on port 465 with App Password (SSL) ---
    try {
        const gmailUser = (process.env.EMAIL_USER || 'equipoexpertoia@gmail.com').trim();
        const gmailPass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');

        if (gmailUser && gmailPass) {
            if (gmailUser.toLowerCase().trim() !== adminEmail) {
                throw new Error(`Gmail user ${gmailUser} does not match adminEmail ${adminEmail}`);
            }

            console.log(`[AdminMailService] Attempting env Gmail SMTP:465 send via ${gmailUser}`);
            const transporter465 = nodemailer.createTransport({
                host: 'smtp.gmail.com',
                port: 465,
                secure: true,
                auth: { user: gmailUser, pass: gmailPass },
                connectionTimeout: SMTP_TIMEOUT_MS,
                greetingTimeout: SMTP_TIMEOUT_MS,
                socketTimeout: SMTP_TIMEOUT_MS,
            });
            const info = await transporter465.sendMail({
                from: `"Equipo Experto Notification" <${gmailUser}>`,
                to: adminEmail,
                replyTo: replyTo || undefined,
                subject,
                text,
                html,
            });
            console.log(`[AdminMailService] ✅ Sent via env Gmail SMTP:465: ${info.messageId}`);
            return { success: true, messageId: info.messageId, provider: 'env_gmail_smtp_465' };
        }
    } catch (err465) {
        console.warn(`[AdminMailService] Env Gmail SMTP:465 failed: ${err465.message}`);
        errors.push(`env_gmail_smtp_465:${err465.message}`);
    }

    // --- STRATEGY 3: Try Database-configured Google OAuth integration for the admin user (If matches admin email) ---
    try {
        const adminRes = await pool.query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [adminEmail]);
        const targetUserId = adminRes.rows[0]?.id || (await pool.query(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`)).rows[0]?.id;

        if (targetUserId) {
            const integrationRes = await pool.query(
                `SELECT account_id, metadata FROM integrations WHERE user_id = $1 AND provider = 'google' LIMIT 1`,
                [targetUserId]
            );
            const integration = integrationRes.rows[0];
            if (integration) {
                let fromEmail = '';
                try {
                    const meta = typeof integration.metadata === 'string' ? JSON.parse(integration.metadata) : (integration.metadata || {});
                    fromEmail = meta.email || integration.account_id?.replace(/^gmail:/i, '') || '';
                } catch (err) {
                    fromEmail = integration.account_id?.replace(/^gmail:/i, '') || '';
                }
                fromEmail = fromEmail.trim().toLowerCase();

                if (fromEmail === adminEmail) {
                    const { getValidGoogleToken } = await import('../utils/googleAuth.js');
                    const { buildGmailRawMime } = await import('../utils/mimeMessage.js');
                    const { default: fetch } = await import('node-fetch');

                    const accessToken = await getValidGoogleToken(targetUserId);
                    if (accessToken) {
                        console.log(`[AdminMailService] Attempting Gmail API send (From: ${fromEmail})`);
                        const mailOptions = {
                            to: adminEmail,
                            replyTo: replyTo || undefined,
                            subject,
                            text,
                            html,
                            from: `"Equipo Experto Notification" <${fromEmail}>`,
                        };
                        const encodedMail = await buildGmailRawMime(mailOptions, fromEmail);
                        const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                            method: 'POST',
                            headers: {
                                Authorization: `Bearer ${accessToken}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ raw: encodedMail }),
                        });
                        if (response.ok) {
                            const data = await response.json();
                            console.log(`[AdminMailService] ✅ Sent via Gmail API (OAuth): ${data.id}`);
                            return { success: true, messageId: data.id, provider: 'gmail_api' };
                        } else {
                            const errData = await response.json().catch(() => ({}));
                            throw new Error(errData.error?.message || `Gmail API HTTP ${response.status}`);
                        }
                    }
                } else {
                    console.warn(`[AdminMailService] Google integration email ${fromEmail} does not match adminEmail ${adminEmail}, skipping Strategy 3`);
                }
            }
        }
    } catch (err) {
        console.warn(`[AdminMailService] Gmail API OAuth Strategy failed: ${err.message}`);
        errors.push(`gmail_api_oauth:${err.message}`);
    }

    // --- STRATEGY 4: Try Database-configured SMTP Settings for the admin user (If matches admin email) ---
    try {
        const adminRes = await pool.query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [adminEmail]);
        const targetUserId = adminRes.rows[0]?.id || (await pool.query(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`)).rows[0]?.id;

        if (targetUserId) {
            const smtpRes = await pool.query('SELECT * FROM smtp_settings WHERE user_id = $1 AND is_active = true LIMIT 1', [targetUserId]);
            const config = smtpRes.rows[0];
            if (config) {
                const configFrom = config.from_email.toLowerCase().trim();
                if (configFrom === adminEmail) {
                    console.log(`[AdminMailService] Attempting DB SMTP send via ${config.from_email}`);
                    const transporter = nodemailer.createTransport({
                        host: config.host,
                        port: config.port,
                        secure: config.secure === true || config.secure === 'true' || config.secure === 1,
                        auth: { user: config.auth_user, pass: config.auth_pass },
                        connectionTimeout: SMTP_TIMEOUT_MS,
                        greetingTimeout: SMTP_TIMEOUT_MS,
                        socketTimeout: SMTP_TIMEOUT_MS,
                    });
                    const finalFrom = config.from_name ? `"${config.from_name}" <${config.from_email}>` : config.from_email;
                    const info = await transporter.sendMail({
                        from: finalFrom,
                        to: adminEmail,
                        replyTo: replyTo || undefined,
                        subject,
                        text,
                        html,
                    });
                    console.log(`[AdminMailService] ✅ Sent via DB SMTP settings: ${info.messageId}`);
                    return { success: true, messageId: info.messageId, provider: 'db_smtp' };
                } else {
                    console.warn(`[AdminMailService] DB SMTP from_email ${configFrom} does not match adminEmail ${adminEmail}, skipping Strategy 4`);
                }
            }
        }
    } catch (err) {
        console.warn(`[AdminMailService] DB SMTP Strategy failed: ${err.message}`);
        errors.push(`db_smtp:${err.message}`);
    }

    // --- STRATEGY 5: Try env CDMON SMTP ---
    try {
        const supportHost = process.env.SUPPORT_SMTP_HOST?.trim();
        const supportUser = process.env.SUPPORT_SMTP_USER?.trim();
        const supportPass = process.env.SUPPORT_SMTP_PASS?.trim();
        if (supportHost && supportUser && supportPass && !isPlaceholderSmtpPass(supportPass)) {
            if (supportUser.toLowerCase().trim() === adminEmail) {
                console.log(`[AdminMailService] Attempting CDMON SMTP send via ${supportUser}`);
                const port = parseInt(process.env.SUPPORT_SMTP_PORT || '465', 10);
                const secure = process.env.SUPPORT_SMTP_SECURE !== 'false';
                const transporter = nodemailer.createTransport({
                    host: supportHost,
                    port: isNaN(port) ? 465 : port,
                    secure,
                    auth: { user: supportUser, pass: supportPass },
                    connectionTimeout: SMTP_TIMEOUT_MS,
                    greetingTimeout: SMTP_TIMEOUT_MS,
                    socketTimeout: SMTP_TIMEOUT_MS,
                });
                const info = await transporter.sendMail({
                    from: `"Equipo Experto Notification" <${supportUser}>`,
                    to: adminEmail,
                    replyTo: replyTo || undefined,
                    subject,
                    text,
                    html,
                });
                console.log(`[AdminMailService] ✅ Sent via CDMON SMTP: ${info.messageId}`);
                return { success: true, messageId: info.messageId, provider: 'cdmon_smtp' };
            } else {
                console.warn(`[AdminMailService] CDMON supportUser ${supportUser} does not match adminEmail ${adminEmail}, skipping Strategy 5`);
            }
        }
    } catch (err) {
        console.warn(`[AdminMailService] CDMON SMTP Strategy failed: ${err.message}`);
        errors.push(`cdmon_smtp:${err.message}`);
    }

    throw new Error(`All notification strategies failed: ${errors.join('; ')}`);
}
