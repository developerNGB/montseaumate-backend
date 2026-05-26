import pool from '../db/pool.js';
import { createEmailTemplate } from '../utils/templateUtils.js';
import { sendDynamicEmail } from './emailService.js';
import * as whatsappService from './whatsappService.js';

const sendOwnerEmail = async (userId, to, subject, message) => {
    if (!to) return 'none';
    try {
        const result = await sendDynamicEmail(userId, {
            to,
            subject,
            text: message,
            html: createEmailTemplate(message, 'there', subject),
        });
        return result.provider || 'email';
    } catch (err) {
        console.error('[OwnerNotify][Email] failed:', err.message);
        return 'none';
    }
};

const sendOwnerWhatsApp = async (userId, phone, message) => {
    if (!phone) return 'none';
    try {
        const waInt = await pool.query(
            `SELECT access_token FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
            [userId]
        );
        if (waInt.rows[0]?.access_token !== 'whatsapp_native_session') return 'none';
        await whatsappService.sendWhatsAppMessage(userId, phone, message);
        return 'whatsapp';
    } catch (err) {
        console.error('[OwnerNotify][WhatsApp] failed:', err.message);
        return 'none';
    }
};

export async function loadOwnerNotifyTargets(userId) {
    const res = await pool.query(
        `SELECT rfs.notification_email,
                rfs.whatsapp_number_fallback,
                rfs.whatsapp_enabled,
                rfs.email_enabled,
                u.email AS user_email
         FROM users u
         LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
         WHERE u.id = $1`,
        [userId]
    );
    const row = res.rows[0] || {};
    return {
        emailTo: (row.notification_email || row.user_email || '').trim() || null,
        whatsappPhone: (row.whatsapp_number_fallback || '').trim() || null,
        emailEnabled: row.email_enabled !== false,
        whatsappEnabled: row.whatsapp_enabled !== false,
    };
}

export async function notifyOwnerChannels(
    userId,
    { subject, message, emailTo, whatsappPhone, emailEnabled = true, whatsappEnabled = true }
) {
    const tasks = [];
    if (emailEnabled !== false && emailTo) {
        tasks.push(sendOwnerEmail(userId, emailTo, subject, message));
    }
    if (whatsappEnabled !== false && whatsappPhone) {
        tasks.push(sendOwnerWhatsApp(userId, whatsappPhone, message));
    }
    if (!tasks.length) {
        console.warn('[OwnerNotify] No owner email or WhatsApp number configured');
        return;
    }
    await Promise.allSettled(tasks);
}

export async function notifyOwnerBulkSendComplete(
    userId,
    { purpose = 'review', sent = 0, total = 0, folderName = null }
) {
    const targets = await loadOwnerNotifyTargets(userId);
    const failed = Math.max(0, total - sent);
    const isReview = purpose === 'review';
    const isCapture = purpose === 'capture';
    const itemLabel = isReview
        ? 'review request'
        : isCapture
          ? 'capture message'
          : 'follow-up message';
    const items = sent === 1 ? itemLabel : `${itemLabel}s`;

    let body = `${sent} ${items} sent`;
    if (folderName) body += ` to contacts in "${folderName}"`;
    if (total > 0 && sent < total) {
        body += ` (${sent}/${total} delivered)`;
    }
    body += '.';
    if (failed > 0) {
        body += `\n\n${failed} could not be delivered — check WhatsApp and Gmail under Integrations.`;
    }

    const subject = isReview
        ? `Review outreach: ${sent} of ${total} sent`
        : isCapture
          ? `Lead capture: ${sent} of ${total} sent`
          : `Lead follow-up: ${sent} of ${total} sent`;

    await notifyOwnerChannels(userId, {
        subject,
        message: body,
        ...targets,
    });
}
