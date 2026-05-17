import pool from '../db/pool.js';
import { buildContactFormEmail } from '../utils/contactFormEmail.js';
import {
    getContactFormInbox,
    isPlatformGmailConfigured,
    sendPlatformGmail,
} from './supportMailService.js';
import { sendDynamicEmail } from './emailService.js';

/**
 * Workspace user whose Google/Microsoft integration can send contact-form mail (fallback).
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
                 OR LOWER(COALESCE(account_id, '')) = LOWER($2)
               )
             ORDER BY updated_at DESC
             LIMIT 1`,
            [inbox, `gmail:${inbox}`],
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
    if (isPlatformGmailConfigured()) return true;
    return Boolean(await resolveContactFormSenderUserId());
}

/**
 * @param {{ name: string, email: string, message: string, source?: string }} payload
 */
export async function sendContactFormNotification({ name, email, message, source }) {
    const to = getContactFormInbox();
    const built = buildContactFormEmail({ name, email, message, source });
    const mailOptions = {
        to,
        subject: built.subject,
        html: built.html,
        text: built.text,
        replyTo: built.replyTo,
        from: built.from,
        headers: built.headers,
        messageId: built.messageId,
    };

    // 1. Platform Gmail app password (equipoexpertoia) — same delivery that worked before; never CDMON.
    if (isPlatformGmailConfigured()) {
        try {
            await sendPlatformGmail(mailOptions);
            console.log(`[contactForm] Sent via platform Gmail → ${to}`);
            return { success: true, provider: 'platform_gmail' };
        } catch (err) {
            console.warn(`[contactForm] Platform Gmail failed (${err.code || err.message}); trying integration`);
        }
    }

    // 2. Connected Integrations Gmail/Microsoft API (same path as lead follow-ups).
    const userId = await resolveContactFormSenderUserId();
    if (userId) {
        try {
            const result = await sendDynamicEmail(userId, mailOptions, { integrationsOnly: true });
            console.log(`[contactForm] Sent via ${result.provider} (user ${userId}) → ${to}`);
            return result;
        } catch (err) {
            console.error(`[contactForm] Integration send failed:`, err.message);
            throw err;
        }
    }

    const err = new Error(
        'Contact form email is not configured. Set EMAIL_USER/EMAIL_PASS on the server or connect Gmail under Integrations.',
    );
    err.code = 'contact_sender_not_configured';
    throw err;
}
