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
        const res = await pool.query(
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
        return null;
    } catch (err) {
        console.error('[AdminMailService] Error fetching token from DB:', err.message);
        return null;
    }
}

function encodeMessage({ to, from, replyTo, subject, text, html }) {
    const lines = [
        `To: ${to}`,
        `From: ${from}`,
        replyTo ? `Reply-To: ${replyTo}` : '',
        `Subject: ${subject}`,
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
 * Sends a notification email to the admin inbox over HTTPS using the Gmail REST API.
 * Uses environment variable credentials if set, otherwise falls back to querying the database
 * for the active Google Integration of the admin inbox (toEmail).
 */
export async function sendAdminNotification({ subject, text, html, replyTo }) {
    const toEmail = (process.env.CONTACT_FORM_TO || process.env.EMAIL_USER || 'equipoexpertoia@gmail.com').trim().toLowerCase();

    let activeRefreshToken = envRefreshToken;
    let activeFromEmail = process.env.GMAIL_USER || process.env.EMAIL_USER || 'equipoexpertoia@gmail.com';

    if (!activeRefreshToken) {
        console.log(`[AdminMailService] GOOGLE_REFRESH_TOKEN not found in env. Searching DB integrations for ${toEmail}...`);
        const dbResult = await getRefreshTokenFromDb(toEmail);
        if (dbResult) {
            activeRefreshToken = dbResult.token;
            activeFromEmail = dbResult.senderEmail;
            console.log(`[AdminMailService] Found active DB Google integration for sender: ${activeFromEmail}`);
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
        from: `"Equipo Experto Notification" <${activeFromEmail}>`,
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
