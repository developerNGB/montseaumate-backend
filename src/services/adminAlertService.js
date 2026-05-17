import crypto from 'crypto';
import { getContactFormInbox, isSupportMailConfigured, sendSupportMail } from './supportMailService.js';

const adminInbox = () => getContactFormInbox();

function alertMailMeta(subject) {
    const token = crypto.randomBytes(4).toString('hex');
    const ts = Date.now();
    return {
        messageId: `<admin-alert.${ts}.${token}@equipoexperto.com>`,
        headers: {
            'X-Entity-Ref-ID': crypto.randomUUID(),
            'X-Admin-Alert': 'true',
            'X-Auto-Response-Suppress': 'All',
        },
        subject: subject?.includes(`#${token}`) ? subject : `${subject} [#${token}]`,
    };
}

/**
 * Fire-and-forget alert to the operations inbox (contact form destination by default).
 */
export async function notifyAdmin({ subject, text, html }) {
    const to = adminInbox();
    if (!isSupportMailConfigured() || !to) {
        console.warn('[AdminAlert] Skipped (no SMTP or inbox):', subject);
        return false;
    }
    try {
        const baseSubject = subject || 'Equipo Experto — system alert';
        const meta = alertMailMeta(baseSubject);
        await sendSupportMail({
            from: 'Equipo Experto Alerts',
            to,
            subject: meta.subject,
            text: text || '',
            html: html || undefined,
            messageId: meta.messageId,
            headers: meta.headers,
        });
        return true;
    } catch (err) {
        console.error('[AdminAlert] send failed:', err.code || err.message);
        return false;
    }
}

export function notifyAdminFireAndForget(payload) {
    notifyAdmin(payload).catch((e) => console.error('[AdminAlert]', e.message));
}
