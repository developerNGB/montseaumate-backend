import pool from '../db/pool.js';
import { buildContactFormEmail } from '../utils/contactFormEmail.js';
import { getContactFormInbox } from './supportMailService.js';
import { sendDynamicEmail } from './emailService.js';
import { getValidGoogleTokens } from '../utils/googleAuth.js';
import {
    getPlatformGmailFromAddress,
    isPlatformGmailConfigured,
    sendPlatformGmail,
} from './platformGmail.js';

const SMTP_FALLBACK_MS = 12_000;

/**
 * User whose connected Gmail (API) sends contact notifications — works on Render (HTTPS).
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
             WHERE provider = 'google'
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
        `SELECT user_id FROM integrations WHERE provider = 'google' ORDER BY updated_at DESC LIMIT 1`,
    );
    return latestGoogle.rows[0]?.user_id ? String(latestGoogle.rows[0].user_id) : null;
}

async function canSendViaGmailApi() {
    const userId = await resolveContactFormSenderUserId();
    if (!userId) return false;
    const { access_token } = await getValidGoogleTokens(userId);
    return Boolean(access_token);
}

export async function isContactFormMailConfigured() {
    if (await canSendViaGmailApi()) return true;
    return isPlatformGmailConfigured();
}

function buildMailPayload({ name, email, message, source }) {
    const to = getContactFormInbox();
    const built = buildContactFormEmail({ name, email, message, source });
    return {
        to,
        built,
        mailOptions: {
            to,
            replyTo: built.replyTo,
            subject: built.subject,
            html: built.html,
            text: built.text,
            from: built.from,
            headers: built.headers,
            messageId: built.messageId,
        },
    };
}

async function sendViaGmailApi(mailOptions) {
    const userId = await resolveContactFormSenderUserId();
    if (!userId) return null;

    const result = await sendDynamicEmail(userId, mailOptions, { integrationsOnly: true });
    console.log(`[contactForm] Gmail API (${result.provider}, user ${userId}) → ${mailOptions.to}`);
    return { ...result, to: mailOptions.to };
}

async function sendViaPlatformSmtp(mailOptions) {
    if (!isPlatformGmailConfigured()) return null;

    const sendPromise = sendPlatformGmail(mailOptions);
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            const err = new Error('SMTP_TIMEOUT');
            err.code = 'SMTP_TIMEOUT';
            reject(err);
        }, SMTP_FALLBACK_MS);
    });

    const info = await Promise.race([sendPromise, timeoutPromise]);
    console.log(
        `[contactForm] Platform SMTP (${getPlatformGmailFromAddress()}) → ${mailOptions.to} id=${info.messageId}`,
    );
    return { success: true, provider: 'platform_gmail', messageId: info.messageId, to: mailOptions.to };
}

/**
 * Production (Render): Gmail API first — outbound SMTP is blocked.
 * Local dev: Gmail API if connected, else app-password SMTP.
 */
export async function sendContactFormNotification({ name, email, message, source }) {
    const { mailOptions } = buildMailPayload({ name, email, message, source });

    try {
        if (await canSendViaGmailApi()) {
            return await sendViaGmailApi(mailOptions);
        }
    } catch (err) {
        console.warn(`[contactForm] Gmail API failed (${err.message}); trying SMTP fallback`);
    }

    try {
        const smtpResult = await sendViaPlatformSmtp(mailOptions);
        if (smtpResult) return smtpResult;
    } catch (err) {
        if (await canSendViaGmailApi()) {
            throw err;
        }
        console.warn(`[contactForm] Platform SMTP failed (${err.code || err.message})`);
    }

    const err = new Error(
        'Contact form email is not configured. Connect Gmail under Dashboard → Integrations, or set EMAIL_USER/EMAIL_PASS on the API server.',
    );
    err.code = 'contact_sender_not_configured';
    throw err;
}
