import pool from '../db/pool.js';
import { createEmailTemplate } from '../utils/templateUtils.js';
import { sendDynamicEmail } from './emailService.js';
import * as whatsappService from './whatsappService.js';
import { frontendBaseUrl } from '../utils/publicUrls.js';

function digitsOnly(phone) {
    return String(phone || '').trim().replace(/\D/g, '');
}

/** Owner phone for self-notifications: fallback field, else connected WhatsApp account. */
export async function resolveOwnerWhatsAppPhone(userId) {
    const [cfgRes, waRes] = await Promise.all([
        pool.query(
            `SELECT whatsapp_number_fallback FROM review_funnel_settings WHERE user_id = $1`,
            [userId],
        ),
        pool.query(
            `SELECT access_token, account_id FROM integrations
             WHERE user_id = $1 AND provider = 'whatsapp'`,
            [userId],
        ),
    ]);

    const wa = waRes.rows[0];
    if (!wa || wa.access_token !== 'whatsapp_native_session') {
        return null;
    }

    const fallback = digitsOnly(cfgRes.rows[0]?.whatsapp_number_fallback);
    const account = digitsOnly(wa.account_id);
    return fallback || account || null;
}

function isOwnerWhatsAppReady(userId) {
    const status = whatsappService.getSessionStatus(userId)?.status;
    return status === 'connected';
}

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
    const targetPhone = digitsOnly(phone) || (await resolveOwnerWhatsAppPhone(userId));
    if (!targetPhone) {
        console.warn('[OwnerNotify][WA] No owner phone — set fallback number or connect WhatsApp');
        return 'none';
    }

    try {
        const waInt = await pool.query(
            `SELECT access_token FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
            [userId],
        );
        if (waInt.rows[0]?.access_token !== 'whatsapp_native_session') {
            return 'none';
        }

        const status = whatsappService.getSessionStatus(userId)?.status;
        if (status !== 'connected') {
            console.warn(`[OwnerNotify][WA] Session not connected (${status || 'unknown'})`);
            return 'none';
        }

        await whatsappService.sendWhatsAppMessage(userId, targetPhone, message);
        console.log(`[OwnerNotify][WA] Delivered to ${targetPhone}`);
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
                lfs.whatsapp_enabled AS lfs_whatsapp_enabled,
                u.email AS user_email
         FROM users u
         LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
         LEFT JOIN lead_followup_settings lfs ON lfs.user_id = u.id
         WHERE u.id = $1`,
        [userId],
    );
    const row = res.rows[0] || {};
    const whatsappPhone = await resolveOwnerWhatsAppPhone(userId);
    const waLinked = Boolean(whatsappPhone);
    const waSessionOk = waLinked && isOwnerWhatsAppReady(userId);

    return {
        emailTo: (row.notification_email || row.user_email || '').trim() || null,
        whatsappPhone,
        emailEnabled: row.email_enabled !== false,
        /** Owner self-alerts use the connected WhatsApp session, not lead-facing channel toggles. */
        whatsappEnabled: waSessionOk,
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
    if (whatsappEnabled !== false) {
        tasks.push(sendOwnerWhatsApp(userId, whatsappPhone, message));
    }
    if (!tasks.length) {
        console.warn('[OwnerNotify] No owner email or WhatsApp channel available');
        return { email: 'none', whatsapp: 'none' };
    }
    const results = await Promise.allSettled(tasks);
    const channels = { email: 'none', whatsapp: 'none' };
    let i = 0;
    if (emailEnabled !== false && emailTo) {
        channels.email = results[i]?.status === 'fulfilled' ? results[i].value : 'none';
        i += 1;
    }
    if (whatsappEnabled !== false) {
        channels.whatsapp = results[i]?.status === 'fulfilled' ? results[i].value : 'none';
    }
    return channels;
}

/** After CSV/Excel import — owner WhatsApp with link to Leads page. */
export async function notifyOwnerLeadImportComplete(
    userId,
    { imported = 0, folderName = null, fileDups = 0, dbDups = 0, importPurpose = 'capture' }
) {
    if (!imported || imported < 1) return;

    const targets = await loadOwnerNotifyTargets(userId);
    const leadWord = imported === 1 ? 'lead' : 'leads';
    const verb =
        importPurpose === 'followup'
            ? 'added for follow-up'
            : importPurpose === 'review'
              ? 'added for review requests'
              : 'captured';

    let body = `${imported} ${leadWord} were ${verb} just now`;
    if (folderName) {
        body += ` in "${folderName}"`;
    }
    body += '.';

    const skipped = fileDups + dbDups;
    if (skipped > 0) {
        body += ` (${skipped} duplicate${skipped === 1 ? '' : 's'} skipped.)`;
    }

    const base = frontendBaseUrl();
    if (base && folderName) {
        const leadsUrl = `${base}/dashboard/leads?folder=${encodeURIComponent(folderName)}`;
        body += `\n\nView here: ${leadsUrl}`;
    } else if (base) {
        body += `\n\nView here: ${base}/dashboard/leads`;
    }

    const subject =
        imported === 1
            ? '1 new contact imported'
            : `${imported} new contacts imported`;

    await notifyOwnerChannels(userId, {
        subject,
        message: body,
        ...targets,
    });
}

/** Instant alert when a newly captured lead scores "high" — surfaced separately from the routine new-lead notice. */
export async function notifyOwnerHotLead(
    userId,
    { fullName, email, phone, message, score, matchedKeywords = [], leadId }
) {
    const targets = await loadOwnerNotifyTargets(userId);
    const base = frontendBaseUrl();
    const dashLeads = base ? `${base}/dashboard/leads${leadId ? `?lead=${leadId}` : ''}` : '';

    let body = `🔥 Hot lead alert!\n\nName: ${fullName}\nEmail: ${email}\nPhone: ${phone}\nScore: ${score}/100`;
    if (message) body += `\nMessage: ${message}`;
    if (matchedKeywords.length > 0) {
        body += `\n\nWhy it's hot: mentioned "${matchedKeywords.join('", "')}"`;
    }
    body += `\n\nReach out fast — leads contacted within minutes convert far better.`;
    if (dashLeads) body += `\n\n${dashLeads}`;

    await notifyOwnerChannels(userId, {
        subject: `🔥 Hot lead: ${fullName}`,
        message: body,
        ...targets,
    });
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
