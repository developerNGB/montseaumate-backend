import nodemailer from 'nodemailer';

const SMTP_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 20_000;

function gmailConfig() {
    const user = process.env.EMAIL_USER?.trim();
    const pass = process.env.EMAIL_PASS?.replace(/\s+/g, '');
    if (!user || !pass) return null;
    return {
        mode: 'gmail',
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user, pass },
        fromAddress: user,
    };
}

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

function supportSmtpConfig() {
    const supportHost = process.env.SUPPORT_SMTP_HOST?.trim();
    const supportUser = process.env.SUPPORT_SMTP_USER?.trim();
    const supportPass = process.env.SUPPORT_SMTP_PASS?.trim();
    if (!supportHost || !supportUser || !supportPass || isPlaceholderSmtpPass(supportPass)) return null;

    const port = Number.parseInt(process.env.SUPPORT_SMTP_PORT || '465', 10);
    const secure = process.env.SUPPORT_SMTP_SECURE !== 'false';
    return {
        mode: 'support_smtp',
        host: supportHost,
        port: Number.isFinite(port) ? port : 465,
        secure,
        auth: { user: supportUser, pass: supportPass },
        fromAddress: supportUser,
    };
}

function buildSmtpConfig() {
    return supportSmtpConfig() || gmailConfig();
}

function isRecoverableSmtpError(err) {
    const code = err?.code || '';
    return ['EAUTH', 'ESOCKET', 'ETIMEDOUT', 'ECONNECTION', 'SMTP_TIMEOUT', 'EDNS'].includes(code);
}

const transporterCache = new Map();

export function isSupportMailConfigured() {
    return Boolean(supportSmtpConfig() || gmailConfig());
}

export function getContactFormInbox() {
    return (
        process.env.CONTACT_FORM_TO?.trim() ||
        process.env.EMAIL_USER?.trim() ||
        process.env.SUPPORT_EMAIL?.trim() ||
        process.env.ADMIN_ALERT_EMAIL?.trim() ||
        'equipoexpertoia@gmail.com'
    );
}

function createTransporter(cfg) {
    const key = `${cfg.mode}:${cfg.host}:${cfg.port}:${cfg.auth.user}`;
    if (transporterCache.has(key)) {
        return { transporter: transporterCache.get(key), fromAddress: cfg.fromAddress, mode: cfg.mode };
    }
    const transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.auth,
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
    });
    transporterCache.set(key, transporter);
    return { transporter, fromAddress: cfg.fromAddress, mode: cfg.mode };
}

function getTransporter(cfg) {
    if (!cfg) return null;
    return createTransporter(cfg);
}

/**
 * @param {import('nodemailer').SendMailOptions} mailOptions
 */
async function sendWithTransporter(bundle, mailOptions) {
    const sendPromise = bundle.transporter.sendMail({
        ...mailOptions,
        from: mailOptions.from
            ? `"${mailOptions.from}" <${bundle.fromAddress}>`
            : bundle.fromAddress,
    });

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error('SMTP_TIMEOUT');
            err.code = 'SMTP_TIMEOUT';
            reject(err);
        }, SEND_TIMEOUT_MS);
    });

    try {
        return await Promise.race([sendPromise, timeoutPromise]);
    } finally {
        clearTimeout(timer);
    }
}

export async function sendSupportMail(mailOptions) {
    const primary = buildSmtpConfig();
    if (!primary) {
        const err = new Error('SMTP_NOT_CONFIGURED');
        err.code = 'SMTP_NOT_CONFIGURED';
        throw err;
    }

    const primaryBundle = getTransporter(primary);
    try {
        return await sendWithTransporter(primaryBundle, mailOptions);
    } catch (err) {
        const gmail = gmailConfig();
        if (
            primary.mode === 'support_smtp' &&
            gmail &&
            isRecoverableSmtpError(err)
        ) {
            console.warn(
                `[supportMail] ${primary.host} failed (${err.code || err.message}); retrying with Gmail`,
            );
            return await sendWithTransporter(getTransporter(gmail), mailOptions);
        }
        throw err;
    }
}
