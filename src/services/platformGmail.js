import nodemailer from 'nodemailer';

let cachedTransporter = null;
const PLATFORM_GMAIL_TIMEOUT_MS = 4_500;
const PLATFORM_GMAIL_SEND_TIMEOUT_MS = 6_500;

function normalizeAppPassword(pass) {
    return pass?.replace(/\s+/g, '') || '';
}

function isPlaceholderSecret(pass) {
    if (!pass) return true;
    const lower = pass.toLowerCase();
    return (
        lower.includes('your_') ||
        lower.includes('your-') ||
        lower.includes('changeme') ||
        lower.includes('placeholder') ||
        pass.length < 8
    );
}

/**
 * Same Gmail transport as auth OTP emails (`service: 'gmail'` + app password).
 */
export function getPlatformGmailTransporter() {
    const user = process.env.EMAIL_USER?.trim();
    const pass = normalizeAppPassword(process.env.EMAIL_PASS);
    if (!user || !pass || isPlaceholderSecret(pass)) return null;

    if (!cachedTransporter) {
        cachedTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user, pass },
            connectionTimeout: PLATFORM_GMAIL_TIMEOUT_MS,
            greetingTimeout: PLATFORM_GMAIL_TIMEOUT_MS,
            socketTimeout: PLATFORM_GMAIL_TIMEOUT_MS,
        });
    }
    return cachedTransporter;
}

export function isPlatformGmailConfigured() {
    return Boolean(getPlatformGmailTransporter());
}

export function getPlatformGmailFromAddress() {
    return process.env.EMAIL_USER?.trim() || null;
}

/**
 * @param {import('nodemailer').SendMailOptions} mailOptions
 */
export async function sendPlatformGmail(mailOptions) {
    const transporter = getPlatformGmailTransporter();
    const fromUser = getPlatformGmailFromAddress();
    if (!transporter || !fromUser) {
        const err = new Error('PLATFORM_GMAIL_NOT_CONFIGURED');
        err.code = 'PLATFORM_GMAIL_NOT_CONFIGURED';
        throw err;
    }

    const from =
        mailOptions.from && !String(mailOptions.from).includes('@')
            ? `"${mailOptions.from}" <${fromUser}>`
            : mailOptions.from || `"Equipo Experto" <${fromUser}>`;

    let timer;
    const sendPromise = transporter.sendMail({
        ...mailOptions,
        from,
    });
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error('PLATFORM_GMAIL_TIMEOUT');
            err.code = 'PLATFORM_GMAIL_TIMEOUT';
            reject(err);
        }, PLATFORM_GMAIL_SEND_TIMEOUT_MS);
    });

    const info = await Promise.race([sendPromise, timeoutPromise]).finally(() => clearTimeout(timer));

    const rejected = info?.rejected || [];
    if (rejected.length > 0 || !info?.messageId) {
        const err = new Error(`Gmail rejected recipients: ${rejected.join(', ') || 'unknown'}`);
        err.code = 'PLATFORM_GMAIL_REJECTED';
        throw err;
    }

    return info;
}
