import fetch from 'node-fetch';
import pool from '../db/pool.js';
import { buildContactFormEmail } from '../utils/contactFormEmail.js';
import { buildGmailRawMime } from '../utils/mimeMessage.js';
import {
    getContactFormInbox,
    gmailConfig,
    sendSupportMail,
} from './supportMailService.js';
import { sendDynamicEmail } from './emailService.js';

function normalizeEmail(value) {
    return value != null ? String(value).trim().toLowerCase() : '';
}

/** Address contact notifications should be sent from (Gmail API / SMTP). */
export function getContactFormFromEmail() {
    return (
        process.env.CONTACT_FORM_GOOGLE_FROM?.trim() ||
        process.env.CONTAFORM_TO?.trim() ||
        process.env.EMAIL_USER?.trim() ||
        getContactFormInbox()
    );
}

function emailsMatch(a, b) {
    const left = normalizeEmail(a);
    const right = normalizeEmail(b);
    return Boolean(left && right && left === right);
}

function isGmailScopeError(err) {
    const msg = String(err?.message || '');
    return (
        /permission denied|insufficient authentication scopes|granted "Send"/i.test(msg) ||
        err?.code === 403
    );
}

/** Skip to next candidate — do not fail the whole form for one bad account. */
function isRetryableGmailSenderError(err) {
    const msg = String(err?.message || '');
    return (
        isGmailScopeError(err) ||
        /expired|reconnect/i.test(msg) ||
        /No outbound email|not configured for this workspace|Link the Gmail/i.test(msg)
    );
}

/**
 * Ordered list of user IDs to try for Gmail API (contact form only).
 */
export async function listContactFormSenderUserIds() {
    const ids = [];
    const push = (id) => {
        const s = id != null ? String(id).trim() : '';
        if (s && !ids.includes(s)) ids.push(s);
    };

    const fromEmail = getContactFormFromEmail();
    const inbox =
        process.env.CONTACT_FORM_TO?.trim() ||
        process.env.EMAIL_USER?.trim() ||
        process.env.SUPPORT_EMAIL?.trim() ||
        fromEmail;

    // Prefer Google integration for the inbox / FROM address (e.g. equipoexpertoia@gmail.com)
    if (inbox) {
        const byInbox = await pool.query(
            `SELECT user_id
             FROM integrations
             WHERE provider = 'google'
               AND refresh_token IS NOT NULL
               AND (
                 LOWER(COALESCE(metadata->>'email', '')) = LOWER($1)
                 OR LOWER(COALESCE(account_id, '')) = LOWER($1)
                 OR LOWER(COALESCE(account_id, '')) = LOWER($2)
               )
             ORDER BY updated_at DESC`,
            [inbox, `gmail:${inbox}`],
        );
        byInbox.rows.forEach((r) => push(r.user_id));
    }

    const explicitSender = process.env.CONTACT_FORM_SENDER_USER_ID?.trim();
    if (explicitSender) {
        if (fromEmail) {
            const match = await pool.query(
                `SELECT user_id
                 FROM integrations
                 WHERE provider = 'google'
                   AND refresh_token IS NOT NULL
                   AND user_id::text = $1
                   AND (
                     LOWER(COALESCE(metadata->>'email', '')) = LOWER($2)
                     OR LOWER(COALESCE(account_id, '')) = LOWER($2)
                     OR LOWER(COALESCE(account_id, '')) = LOWER($3)
                   )
                 LIMIT 1`,
                [explicitSender, fromEmail, `gmail:${fromEmail}`],
            );
            if (match.rows.length > 0) {
                push(explicitSender);
            }
        } else {
            push(explicitSender);
        }
    }

    const rawEditors = process.env.TRANSLATION_EDITOR_USER_IDS?.trim();
    if (rawEditors) {
        const editorIds = rawEditors.split(',').map((s) => s.trim()).filter(Boolean);
        if (editorIds.length > 0) {
            const editorsWithGoogle = await pool.query(
                `SELECT user_id
                 FROM integrations
                 WHERE provider = 'google'
                   AND refresh_token IS NOT NULL
                   AND user_id::text = ANY($1::text[])
                 ORDER BY updated_at DESC`,
                [editorIds],
            );
            editorsWithGoogle.rows.forEach((r) => push(r.user_id));
        }
    }

    const allGoogle = await pool.query(
        `SELECT user_id
         FROM integrations
         WHERE provider = 'google' AND refresh_token IS NOT NULL
         ORDER BY updated_at DESC`,
    );
    allGoogle.rows.forEach((r) => push(r.user_id));

    return ids;
}

export async function resolveContactFormSenderUserId() {
    const ids = await listContactFormSenderUserIds();
    return ids[0] || null;
}

function hasEnvGmailSender() {
    return Boolean(
        process.env.CONTACT_FORM_GOOGLE_REFRESH_TOKEN?.trim() &&
            process.env.GOOGLE_CLIENT_ID?.trim() &&
            process.env.GOOGLE_CLIENT_SECRET?.trim(),
    );
}

async function refreshEnvGmailAccessToken() {
    const refreshToken = process.env.CONTACT_FORM_GOOGLE_REFRESH_TOKEN.trim();
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID.trim(),
            client_secret: process.env.GOOGLE_CLIENT_SECRET.trim(),
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
    });
    const data = await response.json();
    if (data.error) {
        throw new Error(
            data.error_description || data.error || 'CONTACT_FORM_GOOGLE_REFRESH_TOKEN invalid',
        );
    }
    return data.access_token;
}

async function sendViaEnvGmailApi(mailOptions) {
    if (!hasEnvGmailSender()) return null;

    const from =
        process.env.CONTACT_FORM_GOOGLE_FROM?.trim() ||
        process.env.EMAIL_USER?.trim() ||
        getContactFormInbox();

    const accessToken = await refreshEnvGmailAccessToken();
    const encodedMail = buildGmailRawMime(mailOptions, from);

    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: encodedMail }),
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const code = errData.error?.code;
        if (code === 403) {
            throw new Error(
                'Gmail permission denied. Regenerate CONTACT_FORM_GOOGLE_REFRESH_TOKEN with gmail.send scope.',
            );
        }
        throw new Error(errData.error?.message || `Gmail API HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log(`[contactForm] Env Gmail API (${from}) → ${mailOptions.to} id=${data.id}`);
    return { success: true, provider: 'contact_env_gmail', messageId: data.id, to: mailOptions.to };
}

async function sendViaGmailApiForUser(userId, mailOptions) {
    const result = await sendDynamicEmail(userId, mailOptions, { integrationsOnly: true });
    console.log(`[contactForm] Gmail API (${result.provider}, user ${userId}) → ${mailOptions.to}`);
    return { ...result, to: mailOptions.to };
}

async function sendViaEnvSmtp(mailOptions) {
    const cfg = gmailConfig();
    const fromEmail = getContactFormFromEmail();
    if (!cfg || !emailsMatch(cfg.fromAddress, fromEmail)) return null;

    const info = await sendSupportMail(mailOptions);
    console.log(
        `[contactForm] Env SMTP (${cfg.fromAddress}) → ${mailOptions.to} id=${info.messageId}`,
    );
    return {
        success: true,
        provider: 'contact_env_smtp',
        messageId: info.messageId,
        to: mailOptions.to,
    };
}

async function sendViaGmailApi(mailOptions) {
    const errors = [];

    try {
        const envResult = await sendViaEnvGmailApi(mailOptions);
        if (envResult) return envResult;
    } catch (err) {
        errors.push(`env_gmail:${err.message}`);
        console.warn(`[contactForm] Env Gmail API failed: ${err.message}`);
    }

    try {
        const smtpResult = await sendViaEnvSmtp(mailOptions);
        if (smtpResult) return smtpResult;
    } catch (err) {
        errors.push(`env_smtp:${err.message}`);
        console.warn(`[contactForm] Env SMTP failed: ${err.message}`);
    }

    const userIds = await listContactFormSenderUserIds();
    for (const userId of userIds) {
        try {
            return await sendViaGmailApiForUser(userId, mailOptions);
        } catch (err) {
            errors.push(`gmail_api:${userId}:${err.message}`);
            if (isRetryableGmailSenderError(err)) {
                console.warn(
                    `[contactForm] User ${userId} cannot send (${err.message}); trying next account`,
                );
                continue;
            }
            throw err;
        }
    }

    if (errors.length > 0) {
        const err = new Error(
            `Gmail API could not send (${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''})`,
        );
        if (errors.some((e) => /permission denied|Send/i.test(e))) {
            err.code = 'contact_gmail_scope';
        } else {
            err.code = 'contact_sender_not_configured';
        }
        throw err;
    }

    const err = new Error('No Gmail sender configured for the contact form.');
    err.code = 'contact_sender_not_configured';
    throw err;
}

function hasEnvSmtpSender() {
    const cfg = gmailConfig();
    return Boolean(cfg && emailsMatch(cfg.fromAddress, getContactFormFromEmail()));
}

/** True when env Gmail/SMTP or at least one Google integration can send. */
export async function isContactFormMailConfigured() {
    if (hasEnvGmailSender() || hasEnvSmtpSender()) return true;
    const userIds = await listContactFormSenderUserIds();
    return userIds.length > 0;
}

function buildMailPayload({ name, email, message, source }) {
    const to = getContactFormInbox();
    const built = buildContactFormEmail({ name, email, message, source });
    return {
        to,
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

/**
 * Contact form delivery: env Gmail OAuth, env SMTP (EMAIL_USER), then connected Google accounts.
 * Inbox: CONTACT_FORM_TO (default equipoexpertoia@gmail.com).
 */
export async function sendContactFormNotification({ name, email, message, source }) {
    const { mailOptions } = buildMailPayload({ name, email, message, source });
    return sendViaGmailApi(mailOptions);
}
