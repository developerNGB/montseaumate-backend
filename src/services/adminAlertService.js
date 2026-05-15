import nodemailer from 'nodemailer';

const adminInbox = () =>
    process.env.ADMIN_ALERT_EMAIL ||
    process.env.CONTACT_FORM_TO ||
    'equipoexpertoia@gmail.com';

let transporter;

function getTransporter() {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });
    }
    return transporter;
}

/**
 * Fire-and-forget alert to the operations inbox (contact form destination by default).
 */
export async function notifyAdmin({ subject, text, html }) {
    const transport = getTransporter();
    const to = adminInbox();
    if (!transport || !to) {
        console.warn('[AdminAlert] Skipped (no SMTP or inbox):', subject);
        return false;
    }
    try {
        await transport.sendMail({
            from: `"Equipo Experto Alerts" <${process.env.EMAIL_USER}>`,
            to,
            subject: subject || 'Equipo Experto — system alert',
            text: text || '',
            html: html || undefined,
        });
        return true;
    } catch (err) {
        console.error('[AdminAlert] send failed:', err.message);
        return false;
    }
}

export function notifyAdminFireAndForget(payload) {
    notifyAdmin(payload).catch((e) => console.error('[AdminAlert]', e.message));
}
