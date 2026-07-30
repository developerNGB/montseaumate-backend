import { google } from 'googleapis';
import { loadProjectEnv } from '../utils/loadEnv.js';
import pool from '../db/pool.js';

// Load env vars explicitly to ensure they are available
loadProjectEnv();

const clientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const envRefreshToken = process.env.GOOGLE_REFRESH_TOKEN || process.env.CONTACT_FORM_GOOGLE_REFRESH_TOKEN;

async function getRefreshTokenFromDb(email) {
    try {
        let res = await pool.query(
            `SELECT i.refresh_token, i.account_id, i.metadata
             FROM integrations i
             JOIN users u ON u.id = i.user_id
             WHERE i.provider = 'google' 
               AND i.refresh_token IS NOT NULL
               AND (
                 LOWER(u.email) = LOWER($1)
                 OR LOWER(COALESCE(i.metadata->>'email', '')) = LOWER($1)
                 OR LOWER(COALESCE(i.account_id, '')) = LOWER($1)
                 OR LOWER(COALESCE(i.account_id, '')) = LOWER($2)
               )
             ORDER BY i.updated_at DESC
             LIMIT 1`,
            [email, `gmail:${email}`]
        );
        if (res.rows.length > 0) {
            const row = res.rows[0];
            const senderEmail = row.metadata?.email || row.account_id?.replace(/^gmail:/i, '') || email;
            return { token: row.refresh_token, senderEmail };
        }

        // Fallback: search for ANY admin integration (from process.env.ADMIN_EMAILS)
        const adminEmailsStr = process.env.ADMIN_EMAILS || 'equipoexpertoia@gmail.com';
        const adminEmails = adminEmailsStr.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
        if (adminEmails.length > 0) {
            res = await pool.query(
                `SELECT i.refresh_token, i.account_id, i.metadata
                 FROM integrations i
                 JOIN users u ON u.id = i.user_id
                 WHERE i.provider = 'google' 
                   AND i.refresh_token IS NOT NULL
                   AND LOWER(u.email) = ANY($1)
                 ORDER BY i.updated_at DESC
                 LIMIT 1`,
                [adminEmails]
            );
            if (res.rows.length > 0) {
                const row = res.rows[0];
                const senderEmail = row.metadata?.email || row.account_id?.replace(/^gmail:/i, '') || email;
                return { token: row.refresh_token, senderEmail };
            }
        }
        return null;
    } catch (err) {
        console.error('[AdminMailService] Error fetching token from DB:', err.message);
        return null;
    }
}

function encodeUtf8Header(text) {
    if (!text) return '';
    if (/[^\x00-\x7F]/.test(text)) {
        const b64 = Buffer.from(text, 'utf-8').toString('base64');
        return `=?UTF-8?B?${b64}?=`;
    }
    return text;
}

function encodeMessage({ to, from, replyTo, subject, text, html }) {
    const encodedSubject = encodeUtf8Header(subject);
    const lines = [
        `To: ${to}`,
        `From: ${from}`,
        replyTo ? `Reply-To: ${replyTo}` : '',
        `Subject: ${encodedSubject}`,
        `MIME-Version: 1.0`,
        html ? `Content-Type: text/html; charset=utf-8` : `Content-Type: text/plain; charset=utf-8`,
        ``,
        html || text,
    ].filter(line => line !== '');

    return Buffer.from(lines.join("\r\n"))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/**
 * Sends a generic email over HTTPS using the Gmail REST API.
 * Uses environment variable credentials if set, otherwise falls back to querying the database
 * for the active Google Integration of the admin inbox (toEmail).
 */
export async function sendGmailEmail({ to, subject, text, html, replyTo }) {
    const toEmail = to.trim().toLowerCase();

    let activeRefreshToken = envRefreshToken;
    let activeFromEmail = process.env.GMAIL_USER || process.env.EMAIL_USER || 'equipoexpertoia@gmail.com';

    if (!activeRefreshToken) {
        const adminEmail = (process.env.CONTACT_FORM_TO || process.env.EMAIL_USER || 'equipoexpertoia@gmail.com').trim().toLowerCase();
        const dbResult = await getRefreshTokenFromDb(adminEmail);
        if (dbResult) {
            activeRefreshToken = dbResult.token;
            activeFromEmail = dbResult.senderEmail;
        }
    }

    if (!clientId || !clientSecret || !activeRefreshToken) {
        throw new Error("Missing Google API credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) in environment.");
    }

    // Initialize OAuth2 client dynamically using activeRefreshToken
    const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        "https://developers.google.com/oauthplayground"
    );
    oauth2Client.setCredentials({ refresh_token: activeRefreshToken });
    const gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });

    const raw = encodeMessage({
        to: toEmail,
        from: `"Equipo Experto" <${activeFromEmail}>`,
        replyTo: replyTo,
        subject: subject,
        text: text,
        html: html
    });

    const response = await gmailClient.users.messages.send({
        userId: 'me',
        requestBody: { raw },
    });

    if (!response?.data?.id) {
        throw new Error("Gmail API did not return a message id");
    }

    console.log(`[MAIL] delivered via Gmail API, id=${response.data.id}, from=${activeFromEmail}, to=${toEmail}`);
    return { success: true, messageId: response.data.id, provider: 'gmail_api_https', from: activeFromEmail };
}

/**
 * Sends a notification email to the admin inbox over HTTPS using the Gmail REST API.
 */
export async function sendAdminNotification({ subject, text, html, replyTo }) {
    const toEmail = (process.env.CONTACT_FORM_TO || process.env.EMAIL_USER || 'equipoexpertoia@gmail.com').trim().toLowerCase();
    return sendGmailEmail({
        to: toEmail,
        subject,
        text,
        html,
        replyTo
    });
}
