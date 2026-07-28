import { google } from 'googleapis';
import { loadProjectEnv } from '../utils/loadEnv.js';

// Load env vars explicitly to ensure they are available
loadProjectEnv();

const clientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || process.env.CONTACT_FORM_GOOGLE_REFRESH_TOKEN;

// Initialize OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    "https://developers.google.com/oauthplayground"
);

if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
}

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

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
 * This is the ONLY delivery mechanism to bypass SMTP port blocks on the host.
 */
export async function sendAdminNotification({ subject, text, html, replyTo }) {
    const fromEmail = process.env.GMAIL_USER || process.env.EMAIL_USER || 'equipoexpertoia@gmail.com';
    const toEmail = process.env.CONTACT_FORM_TO || process.env.EMAIL_USER || 'equipoexpertoia@gmail.com';

    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error("Missing Google API credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) in environment.");
    }

    const raw = encodeMessage({
        to: toEmail,
        from: `"Equipo Experto Notification" <${fromEmail}>`,
        replyTo: replyTo,
        subject: subject,
        text: text,
        html: html
    });

    const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
    });

    if (!response?.data?.id) {
        throw new Error("Gmail API did not return a message id");
    }

    console.log(`[MAIL] delivered via Gmail API, id=${response.data.id}, to=${toEmail}`);
    return { success: true, messageId: response.data.id, provider: 'gmail_api_https' };
}
