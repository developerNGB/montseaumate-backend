import pool from '../db/pool.js';
import fetch from 'node-fetch';
import { getValidGoogleToken } from '../utils/googleAuth.js';
import { buildGmailRawMime } from '../utils/mimeMessage.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load env vars explicitly to ensure they are available
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../.env') });

/**
 * Sends a notification email to the admin inbox defined in CONTACT_FORM_TO.
 * Uses Gmail API via the admin user's Google integration.
 */
export async function sendAdminNotification({ subject, text, html, replyTo }) {
    const adminEmail = (process.env.CONTACT_FORM_TO || 'equipoexpertoia@gmail.com').trim();

    // 1. Resolve Admin User ID
    const adminRes = await pool.query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [adminEmail]);
    let targetUserId = adminRes.rows[0]?.id;

    if (!targetUserId) {
        const ownerRes = await pool.query(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`);
        targetUserId = ownerRes.rows[0]?.id;
    }

    if (!targetUserId) {
        throw new Error('No administrator user found in the database.');
    }

    // 2. Fetch Google integration details for this user ID
    const integrationRes = await pool.query(
        `SELECT account_id, metadata FROM integrations WHERE user_id = $1 AND provider = 'google' LIMIT 1`,
        [targetUserId]
    );

    const integration = integrationRes.rows[0];
    if (!integration) {
        throw new Error(`No Google OAuth integration found for admin user (ID: ${targetUserId}). Please link a Google account in the Integrations panel.`);
    }

    // Resolve sender email from integration
    let fromEmail = '';
    try {
        const meta = typeof integration.metadata === 'string' ? JSON.parse(integration.metadata) : (integration.metadata || {});
        fromEmail = meta.email || integration.account_id?.replace(/^gmail:/i, '') || '';
    } catch (err) {
        fromEmail = integration.account_id?.replace(/^gmail:/i, '') || '';
    }
    fromEmail = fromEmail.trim();

    if (!fromEmail) {
        throw new Error('Could not resolve the sender email address from the Google integration.');
    }

    // 3. Get valid access token (refreshes if needed)
    const accessToken = await getValidGoogleToken(targetUserId);
    if (!accessToken) {
        throw new Error('Failed to obtain a valid Google OAuth access token. Admin may need to reconnect Google integration.');
    }

    // 4. Construct raw MIME email
    const mailOptions = {
        to: adminEmail,
        replyTo: replyTo || undefined,
        subject: subject,
        text: text,
        html: html,
        from: `"Equipo Experto Notification" <${fromEmail}>`,
    };

    const encodedMail = await buildGmailRawMime(mailOptions, fromEmail);

    // 5. Send via Gmail API HTTP request
    console.log(`[AdminMailService] Sending Gmail API notification to ${adminEmail} (From: ${fromEmail})`);
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
        throw new Error(errData.error?.message || `Gmail API returned HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log(`[AdminMailService] ✅ Gmail API delivered: ${data.id}`);
    return { success: true, messageId: data.id };
}
