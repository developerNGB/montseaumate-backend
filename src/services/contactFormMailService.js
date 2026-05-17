import pool from '../db/pool.js';
import { buildContactFormEmail } from '../utils/contactFormEmail.js';
import { getContactFormInbox } from './supportMailService.js';
import { sendDynamicEmail } from './emailService.js';

/**
 * Workspace user whose Google/Microsoft integration sends contact-form mail (same path as lead follow-ups).
 */
export async function resolveContactFormSenderUserId() {
    const explicit = process.env.CONTACT_FORM_SENDER_USER_ID?.trim();
    if (explicit) return explicit;

    const inbox =
        process.env.CONTACT_FORM_TO?.trim() ||
        process.env.EMAIL_USER?.trim() ||
        process.env.SUPPORT_EMAIL?.trim();

    if (inbox) {
        const byInbox = await pool.query(
            `SELECT user_id
             FROM integrations
             WHERE provider IN ('google', 'microsoft')
               AND (
                 LOWER(COALESCE(metadata->>'email', '')) = LOWER($1)
                 OR LOWER(COALESCE(account_id, '')) = LOWER($1)
               )
             ORDER BY updated_at DESC
             LIMIT 1`,
            [inbox],
        );
        if (byInbox.rows[0]?.user_id) return String(byInbox.rows[0].user_id);
    }

    const latestGoogle = await pool.query(
        `SELECT user_id
         FROM integrations
         WHERE provider = 'google'
         ORDER BY updated_at DESC
         LIMIT 1`,
    );
    return latestGoogle.rows[0]?.user_id ? String(latestGoogle.rows[0].user_id) : null;
}

export async function isContactFormMailConfigured() {
    return Boolean(await resolveContactFormSenderUserId());
}

/**
 * @param {{ name: string, email: string, message: string, source?: string }} payload
 */
export async function sendContactFormNotification({ name, email, message, source }) {
    const userId = await resolveContactFormSenderUserId();
    if (!userId) {
        const err = new Error(
            'Contact form email is not configured. Connect Gmail under Integrations or set CONTACT_FORM_SENDER_USER_ID.',
        );
        err.code = 'contact_sender_not_configured';
        throw err;
    }

    const to = getContactFormInbox();
    const built = buildContactFormEmail({ name, email, message, source });

    return sendDynamicEmail(
        userId,
        {
            to,
            subject: built.subject,
            html: built.html,
            text: built.text,
            replyTo: built.replyTo,
            from: built.from,
            headers: built.headers,
            messageId: built.messageId,
        },
        { integrationsOnly: true },
    );
}
