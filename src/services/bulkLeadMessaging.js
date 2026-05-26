import pool from '../db/pool.js';
import { DEFAULT_LEAD_GROUP } from '../utils/leadGroups.js';
import { normalizeLeadGroup } from '../utils/leadGroups.js';
import { getFolderMessage } from '../utils/leadFolders.js';
import { dispatchFollowupForLead } from './leadDispatchService.js';
import { insertActivityLog } from './activityLogService.js';
import { notifyOwnerBulkSendComplete } from './ownerNotifyService.js';

async function logBulkActivity(userId, { isReviewBatch, sent, total, groupFilter }) {
    if (total <= 0) return;
    const automationName = isReviewBatch ? 'Review Funnel' : 'Lead Follow-up';
    const triggerType = isReviewBatch ? 'Review request' : 'Bulk Trigger';
    const detail = isReviewBatch
        ? `${sent}/${total} review requests sent`
        : `${sent}/${total} follow-up messages sent`;
    try {
        await insertActivityLog({
            userId,
            automationName,
            triggerType,
            status: sent > 0 ? 'Success' : 'Attention',
            detail,
            metadata: { sent, total, group: groupFilter || null },
        });
    } catch (err) {
        console.error('[bulkLeadMessaging] activity log failed:', err.message);
    }
}

/**
 * Send bulk WhatsApp/email to leads in a folder or by IDs.
 * @returns {{ sent: number, total: number, contactedIds: number[] }}
 */
export async function executeBulkLeadMessaging(
    userId,
    { ids, message: messageOverride, group: groupFilter, purpose, notifyOwner = true }
) {
    const isReviewBatch = purpose === 'review';

    const resolveMessageForLead = async (lead, cfg, reviewCfg) => {
        if (messageOverride?.trim()) return messageOverride.trim();
        if (isReviewBatch && reviewCfg?.auto_response_message?.trim()) {
            return reviewCfg.auto_response_message.trim();
        }
        const folderMsg = await getFolderMessage(userId, lead.lead_group || DEFAULT_LEAD_GROUP);
        if (folderMsg) return folderMsg;
        const sequence =
            typeof cfg?.followup_sequence === 'string'
                ? JSON.parse(cfg.followup_sequence)
                : cfg?.followup_sequence || [];
        if (sequence.length > 0) {
            const idx = lead.followup_step_index || 0;
            if (sequence[idx]?.message) return sequence[idx].message;
        }
        return cfg?.message || 'Hi {name}! Thanks for reaching out.';
    };

    const channelOptions = (cfg, reviewCfg) =>
        isReviewBatch
            ? {
                  whatsappEnabled: reviewCfg?.whatsapp_enabled !== false,
                  emailEnabled: reviewCfg?.email_enabled !== false,
              }
            : {
                  whatsappEnabled: cfg?.whatsapp_enabled !== false,
                  emailEnabled: cfg?.email_enabled !== false,
              };

    const loadConfigs = async () => {
        const [cfgRes, reviewRes] = await Promise.all([
            pool.query(
                `SELECT lfs.message, lfs.followup_sequence, lfs.is_active,
                        lfs.whatsapp_enabled, lfs.email_enabled,
                        u.company_name
                 FROM users u
                 LEFT JOIN lead_followup_settings lfs ON lfs.user_id = u.id
                 WHERE u.id = $1`,
                [userId]
            ),
            pool.query(
                `SELECT auto_response_message, automation_id, google_review_url,
                        whatsapp_enabled, email_enabled, is_active
                 FROM review_funnel_settings WHERE user_id = $1`,
                [userId]
            ),
        ]);
        const cfg = cfgRes.rows[0] || {};
        const reviewRow = reviewRes.rows[0] || {};
        const reviewCfg = {
            auto_response_message: reviewRow.auto_response_message,
            google_review_url: reviewRow.google_review_url,
            automation_id: reviewRow.automation_id,
            whatsapp_enabled: reviewRow.whatsapp_enabled,
            email_enabled: reviewRow.email_enabled,
        };
        return { cfg, reviewCfg };
    };

    const emailSubject = isReviewBatch ? 'We would love your feedback' : 'Message from Our Team';

    const sendToLeads = async (leads, cfg, reviewCfg) => {
        if (!leads.length) return { sent: 0, total: 0, contactedIds: [] };

        if (isReviewBatch && !reviewCfg?.auto_response_message?.trim() && !messageOverride?.trim()) {
            console.warn('[bulkLeadMessaging] Review batch skipped — no auto_response_message configured');
            return { sent: 0, total: leads.length, contactedIds: [] };
        }

        let sent = 0;
        const contactedIds = [];
        const channels = channelOptions(cfg, reviewCfg);

        for (const lead of leads) {
            const msg = await resolveMessageForLead(lead, cfg, reviewCfg);
            const channel = await dispatchFollowupForLead(userId, lead, msg, emailSubject, channels);
            if (channel !== 'none') {
                sent++;
                contactedIds.push(lead.id);
            }
        }

        if (contactedIds.length > 0) {
            await pool.query(
                `UPDATE leads SET
                    lead_status = 'Contacted',
                    followup_step_index = followup_step_index + 1,
                    last_followup_at = NOW(),
                    updated_at = NOW()
                 WHERE id = ANY($1) AND user_id = $2`,
                [contactedIds, userId]
            );
        }

        return { sent, total: leads.length, contactedIds };
    };

    const { cfg, reviewCfg } = await loadConfigs();

    if (Array.isArray(ids) && ids.length > 0) {
        const leadsRes = await pool.query(
            `SELECT l.*, u.company_name, rfs.google_review_url, rfs.automation_id
             FROM leads l
             JOIN users u ON u.id = l.user_id
             LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
             WHERE l.user_id = $1 AND l.id = ANY($2)`,
            [userId, ids]
        );
        const result = await sendToLeads(leadsRes.rows, cfg, reviewCfg);
        await logBulkActivity(userId, {
            isReviewBatch,
            sent: result.sent,
            total: result.total,
            groupFilter,
        });
        if (notifyOwner && result.total > 0) {
            await notifyOwnerBulkSendComplete(userId, {
                purpose,
                sent: result.sent,
                total: result.total,
                folderName: groupFilter || null,
            });
        }
        return result;
    }

    if (groupFilter?.trim()) {
        const folderName = normalizeLeadGroup(groupFilter);
        const leadsRes = await pool.query(
            `SELECT l.*, u.company_name, rfs.google_review_url, rfs.automation_id
             FROM leads l
             JOIN users u ON u.id = l.user_id
             LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
             WHERE l.user_id = $1
               AND COALESCE(NULLIF(TRIM(l.lead_group), ''), $2) = $3
               AND l.lead_status != 'Contacted'`,
            [userId, DEFAULT_LEAD_GROUP, folderName]
        );
        const result = await sendToLeads(leadsRes.rows, cfg, reviewCfg);
        await logBulkActivity(userId, {
            isReviewBatch,
            sent: result.sent,
            total: result.total,
            groupFilter: folderName,
        });
        if (notifyOwner && result.total > 0) {
            await notifyOwnerBulkSendComplete(userId, {
                purpose,
                sent: result.sent,
                total: result.total,
                folderName,
            });
        }
        return result;
    }

    return { sent: 0, total: 0, contactedIds: [] };
}
