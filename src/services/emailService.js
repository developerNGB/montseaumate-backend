import nodemailer from 'nodemailer';
import pool from '../db/pool.js';

/**
 * Service to handle dynamic email dispatching.
 * Prioritizes user's custom SMTP settings if active.
 * Falls back to system Gmail.
 */
export const sendDynamicEmail = async (userId, mailOptions) => {
    try {
        // 1. Fetch User SMTP Settings
        const smtpRes = await pool.query(
            `SELECT * FROM smtp_settings WHERE user_id = $1 AND is_active = true`,
            [userId]
        );

        let transporter;
        let finalFrom;

        if (smtpRes.rows.length > 0) {
            const config = smtpRes.rows[0];
            console.log(`[EmailService] Using Custom SMTP for user ${userId} (${config.from_email})`);
            
            transporter = nodemailer.createTransport({
                host: config.host,
                port: config.port,
                secure: config.secure, // true for 465, false for other ports
                auth: {
                    user: config.auth_user,
                    pass: config.auth_pass,
                },
                tls: {
                    rejectUnauthorized: false // Helps with some self-signed domain certs
                }
            });

            finalFrom = config.from_name 
                ? `"${config.from_name}" <${config.from_email}>` 
                : config.from_email;
        } else {
            console.log(`[EmailService] Using System Gmail for user ${userId}`);
            
            transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                }
            });

            finalFrom = process.env.EMAIL_USER;
        }

        const options = {
            ...mailOptions,
            from: mailOptions.from || finalFrom
        };

        const info = await transporter.sendMail(options);
        console.log('[EmailService] Email sent successfully:', info.messageId);
        return { success: true, messageId: info.messageId };

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
