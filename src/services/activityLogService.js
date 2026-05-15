import pool from '../db/pool.js';
import { dispatchFollowupForLead } from '../controllers/leadsController.js';

export async function insertActivityLog({
    userId,
    automationName,
    triggerType,
    status,
    detail,
    metadata = {},
}) {
    const result = await pool.query(
        `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [userId, automationName, triggerType, status, detail, JSON.stringify(metadata)]
    );
    return result.rows[0]?.id;
}

/**
 * Re-queue a failed automation from activity log metadata.
 */
export async function retryActivityLogForUser(userId, logId) {
    const logRes = await pool.query(
        `SELECT id, automation_name, trigger_type, status, metadata
         FROM activity_logs WHERE id = $1 AND user_id = $2`,
        [logId, userId]
    );
    if (logRes.rows.length === 0) {
        return { ok: false, code: 'NOT_FOUND', message: 'Activity entry not found.' };
    }

    const log = logRes.rows[0];
    let metadata = log.metadata;
    if (typeof metadata === 'string') {
        try {
            metadata = JSON.parse(metadata);
        } catch {
            metadata = {};
        }
    }

    const leadId = metadata?.lead_id || metadata?.leadId;
    if (!leadId) {
        return {
            ok: false,
            code: 'NO_LEAD',
            message: 'This activity cannot be retried automatically. Open the lead and send manually.',
        };
    }

    const leadRes = await pool.query(
        `SELECT l.*, rfs.automation_id, rfs.google_review_url, u.company_name
         FROM leads l
         JOIN users u ON l.user_id = u.id
         LEFT JOIN review_funnel_settings rfs ON l.user_id = rfs.user_id
         WHERE l.id = $1 AND l.user_id = $2`,
        [leadId, userId]
    );
    if (leadRes.rows.length === 0) {
        return { ok: false, code: 'LEAD_GONE', message: 'The related contact was removed.' };
    }

    const lead = leadRes.rows[0];
    const settingsRes = await pool.query(
        `SELECT followup_sequence, whatsapp_enabled, email_enabled FROM lead_followup_settings WHERE user_id = $1`,
        [userId]
    );
    const settings = settingsRes.rows[0] || {};
    let sequence = settings.followup_sequence;
    if (typeof sequence === 'string') {
        try {
            sequence = JSON.parse(sequence);
        } catch {
            sequence = [];
        }
    }
    const stepIndex = Math.max(0, (lead.followup_step_index || 0));
    const step = Array.isArray(sequence) ? sequence[stepIndex] : null;
    const message = step?.message || step?.body || 'Hi {name}, following up on our last conversation.';

    const provider = await dispatchFollowupForLead(userId, lead, message, {
        whatsappEnabled: settings.whatsapp_enabled !== false,
        emailEnabled: settings.email_enabled !== false,
    });

    if (!provider || provider === 'none') {
        await insertActivityLog({
            userId,
            automationName: log.automation_name || 'Lead Follow-up',
            triggerType: log.trigger_type || 'Manual retry',
            status: 'Failed',
            detail: 'Retry failed — check WhatsApp and Gmail under Integrations.',
            metadata: { lead_id: leadId, retry_of: logId },
        });
        return {
            ok: false,
            code: 'SEND_FAILED',
            message: 'Could not send. Check WhatsApp and Gmail connections, then try again.',
        };
    }

    await insertActivityLog({
        userId,
        automationName: log.automation_name || 'Lead Follow-up',
        triggerType: log.trigger_type || 'Manual retry',
        status: 'Success',
        detail: `Retry sent via ${provider}`,
        metadata: { lead_id: leadId, retry_of: logId },
    });

    return { ok: true, provider };
}
