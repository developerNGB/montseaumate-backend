import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load env vars explicitly to ensure they are available
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const SMTP_TIMEOUT_MS = 5000;

function getSmtpConfig() {
    // 1. Try CDMON/Support SMTP first if password is not placeholder
    const supportHost = process.env.SUPPORT_SMTP_HOST?.trim();
    const supportUser = process.env.SUPPORT_SMTP_USER?.trim();
    const supportPass = process.env.SUPPORT_SMTP_PASS?.trim();
    
    const isPlaceholder = !supportPass || 
        supportPass.toLowerCase().includes('your_') || 
        supportPass.toLowerCase().includes('changeme') || 
        supportPass.toLowerCase().includes('placeholder') || 
        supportPass === 'your_cdmon_password_here';

    if (supportHost && supportUser && supportPass && !isPlaceholder) {
        const port = parseInt(process.env.SUPPORT_SMTP_PORT || '465', 10);
        const secure = process.env.SUPPORT_SMTP_SECURE !== 'false';
        return {
            host: supportHost,
            port: isNaN(port) ? 465 : port,
            secure,
            auth: { user: supportUser, pass: supportPass },
            fromAddress: supportUser,
        };
    }

    // 2. Fallback to Gmail SMTP env settings
    const gmailUser = process.env.EMAIL_USER?.trim();
    const gmailPass = process.env.EMAIL_PASS?.replace(/\s+/g, '');
    if (gmailUser && gmailPass) {
        return {
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: { user: gmailUser, pass: gmailPass },
            fromAddress: gmailUser,
        };
    }

    return null;
}

/**
 * Sends a notification email to the admin inbox defined in CONTACT_FORM_TO.
 * Completely isolated from user settings or database integrations.
 */
export async function sendAdminNotification({ subject, text, html, replyTo }) {
    const config = getSmtpConfig();
    if (!config) {
        throw new Error('No valid SMTP configuration found in .env. Please configure SUPPORT_SMTP or EMAIL_USER/EMAIL_PASS.');
    }

    const adminEmail = (process.env.CONTACT_FORM_TO || 'equipoexpertoia@gmail.com').trim();

    const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.auth,
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
    });

    const mailOptions = {
        from: `"Equipo Experto Notification" <${config.fromAddress}>`,
        to: adminEmail,
        replyTo: replyTo || undefined,
        subject: subject,
        text: text,
        html: html,
    };

    console.log(`[AdminMailService] Attempting to deliver notification to ${adminEmail} via ${config.host}`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`[AdminMailService] ✅ Email delivered: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
}
