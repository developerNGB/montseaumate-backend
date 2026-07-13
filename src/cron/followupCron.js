import pool from '../db/pool.js';
import { frontendBaseUrl } from '../utils/publicUrls.js';
import { injectPlaceholders, createEmailTemplate } from '../utils/templateUtils.js';
import { getValidGoogleTokens } from '../utils/googleAuth.js';
import * as whatsappService from '../services/whatsappService.js';
import { sendDynamicEmail } from '../services/emailService.js';
import { sanitizeLeadEmailForPublic } from '../utils/leadPrivacy.js';
import { retryAsync } from '../utils/retryAsync.js';
import { insertActivityLog } from '../services/activityLogService.js';
import { notifyAdminFireAndForget } from '../services/adminAlertService.js';
import {
    assessLeadFollowup,
    FOLLOWUP_RETRY_COOLDOWN_MIN,
    loadUserSendCapabilities,
    shouldSendFollowupFailureAlert,
} from '../services/followupDispatch.js';

/**
 * Helper to calculate the next scheduled time for a follow-up step.
 */
const getScheduledTime = (startTime, delayValue, delayUnit) => {
    const date = new Date(startTime);
    const val = parseFloat(delayValue) || 0;
    
    switch (delayUnit?.toLowerCase()) {
        case 'minutes':
        case 'immediately':
            date.setMinutes(date.getMinutes() + val);
            break;
        case 'days':
            date.setDate(date.getDate() + val);
            break;
        case 'hours':
        default:
            date.setHours(date.getHours() + val);
            break;
    }
    return date;
};

/** Leads left in followup_status = 'processing' (e.g. crash) are reset after this many minutes. */
const STUCK_PROCESSING_AFTER_MIN = Math.max(
    15,
    Math.min(24 * 60, parseInt(process.env.FOLLOWUP_STUCK_PROCESSING_MINUTES || '45', 10) || 45)
);

/** Gmail list query: limit to recent mail (reduces scanning and matches "last day" intent). */
const GMAIL_REPLY_LIST_QUERY = 'newer_than:1d (is:unread OR in:inbox)';

const parseFollowupSequence = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
};

const startFollowupCron = () => {
    console.log('🤖 Automated Follow-up Cron (Batch Mode) Started');

    // ── Gmail Reply Checker ───────────────────────────────────────────────────
    const checkGmailReplies = async () => {
        try {
            // Get all active users with Gmail integration
            const usersRes = await pool.query(
                `SELECT DISTINCT user_id FROM integrations WHERE provider = 'google'`
            );
            
            for (const row of usersRes.rows) {
                const userId = row.user_id;
                const { access_token } = await getValidGoogleTokens(userId);
                if (!access_token) continue;

                const query = GMAIL_REPLY_LIST_QUERY; 
                const response = await fetch(
                    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=25`,
                    {
                        headers: { Authorization: `Bearer ${access_token}` },
                    }
                );

                if (!response.ok) {
                    if (response.status === 403) {
                        // Expected when Gmail is connected with send-only scope (no gmail.readonly / mail.google.com).
                        console.warn(
                            `[GmailReplyChecker] user ${userId}: inbox scan skipped (403 — connect with read scope or use send-only; reply auto-detect disabled).`
                        );
                    }
                    continue;
                }
                const data = await response.json();
                if (!data.messages) continue;

                for (const msg of data.messages) {
                    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
                        headers: { 'Authorization': `Bearer ${access_token}` }
                    });
                    if (!msgRes.ok) continue;
                    const message = await msgRes.json();

                    const headers = message.payload?.headers;
                    if (!Array.isArray(headers)) continue;

                    // Extract sender email
                    const fromHeader =
                        headers.find((h) => String(h?.name || '').toLowerCase() === 'from')?.value || '';
                    const match = fromHeader.match(/<(.+)>|(\S+@\S+)/);
                    const leadEmail = match?.[1] || match?.[2];
                    
                    if (leadEmail) {
                        // If this email matches a lead for this user, mark them as Replied
                        const leadRes = await pool.query(
                            `SELECT id, full_name, lead_status FROM leads
                             WHERE user_id = $1 AND lower(email) = $2`,
                            [userId, leadEmail.toLowerCase()]
                        );
                        if (leadRes.rows.length > 0) {
                            const lead = leadRes.rows[0];
                            if (lead.lead_status !== 'Replied') {
                                await pool.query(
                                    `UPDATE leads SET lead_status = 'Replied', updated_at = NOW() WHERE id = $1`,
                                    [lead.id]
                                );
                                try {
                                    const { notifyOwnerLeadReply } = await import('../services/ownerNotifyService.js');
                                    const replySnippet = message.snippet || 'Replied to your email';
                                    await notifyOwnerLeadReply(userId, lead.full_name, replySnippet);
                                } catch (notifyErr) {
                                    console.error('[GmailReply] Error notifying owner on reply:', notifyErr.message);
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[GmailReplyChecker] Error:', err.message);
        }
    };

    // ── Batch Process ALL leads that are due simultaneously ────────────────────
    const processBatch = async (leads) => {
        if (leads.length === 0) return;

        const userCaps = await loadUserSendCapabilities(leads.map((l) => l.user_id));

        const toSend = [];
        const toComplete = [];
        const toSkip = [];

        for (const lead of leads) {
            lead._parsedSequence = parseFollowupSequence(lead.followup_sequence);
            const caps = userCaps.get(String(lead.user_id)) || { email: false, whatsapp: false };
            const assessment = assessLeadFollowup(lead, caps);
            if (assessment.kind === 'complete') {
                toComplete.push({ lead, reason: assessment.reason });
            } else if (assessment.kind === 'skip') {
                toSkip.push({ lead, reason: assessment.reason });
            } else {
                toSend.push({ lead, assessment });
            }
        }

        if (toComplete.length > 0) {
            const completeIds = toComplete.map((x) => x.lead.id);
            await pool.query(
                `UPDATE leads l
                 SET followup_status = 'pending',
                     followup_step_index = jsonb_array_length(s.followup_sequence),
                     updated_at = NOW()
                 FROM lead_followup_settings s
                 WHERE l.id = ANY($1::uuid[])
                   AND s.user_id = l.user_id`,
                [completeIds],
            );
            console.log(`[FollowupCron] Marked ${completeIds.length} lead(s) follow-up complete (no send needed)`);
        }

        if (toSkip.length > 0) {
            const skipIds = toSkip.map((x) => x.lead.id);
            await pool.query(
                `UPDATE leads
                 SET followup_status = 'pending',
                     last_followup_at = NOW(),
                     updated_at = NOW()
                 WHERE id = ANY($1::uuid[])`,
                [skipIds],
            );
            const byReason = toSkip.reduce((acc, x) => {
                acc[x.reason] = (acc[x.reason] || 0) + 1;
                return acc;
            }, {});
            console.warn(`[FollowupCron] Skipped ${skipIds.length} lead(s) (cooldown ${FOLLOWUP_RETRY_COOLDOWN_MIN}m):`, byReason);
        }

        if (toSend.length === 0) {
            console.log('[FollowupCron] No sendable leads in batch after preflight');
            return;
        }

        console.log(`[FollowupCron] 📦 Sending ${toSend.length} lead(s) (${toComplete.length} complete, ${toSkip.length} skipped)`);

        const waSessions = new Map();
        const leadIds = toSend.map((x) => x.lead.id);

        await pool.query(
            `UPDATE leads SET followup_status = 'processing', updated_at = NOW()
             WHERE id = ANY($1::uuid[]) AND (followup_status IS NULL OR followup_status != 'processing')`,
            [leadIds]
        );

        let results = [];
        try {
            results = await Promise.all(
                toSend.map(async ({ lead, assessment }) => {
                    try {
                        const sequence = lead._parsedSequence;
                        const currentIndex = lead.followup_step_index || 0;
                        const step = sequence[currentIndex];

                        const baseUrl = frontendBaseUrl() || '';
                        if (!baseUrl) console.error('[followupCron] FRONTEND_URL is not set');
                        const link = baseUrl ? `${baseUrl}/r/${lead.automation_id || ''}?source=list` : '';
                        const msg = injectPlaceholders(step.message || '', {
                            name: lead.full_name,
                            link: link,
                            company: lead.company_name || 'Our Company'
                        });

                        let waSent = false;
                        let emailSent = false;

                        // ── TRY WhatsApp ─────────────────────────────────────────────────────
                        try {
                            if (assessment.canWa && !waSessions.has(lead.user_id)) {
                                const intRes = await pool.query(
                                    `SELECT access_token FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
                                    [lead.user_id]
                                );
                                const waAuth = intRes.rows[0] || {};
                                waSessions.set(lead.user_id, {
                                    isNative: waAuth.access_token === 'whatsapp_native_session',
                                    session: waAuth.access_token === 'whatsapp_native_session'
                                        ? whatsappService.getSessionStatus(lead.user_id)
                                        : null
                                });
                            }

                            const session = waSessions.get(lead.user_id);
                            if (assessment.canWa && session?.isNative && session?.session?.status === 'connected' && lead.phone) {
                                await retryAsync(
                                    () => whatsappService.sendWhatsAppMessage(lead.user_id, lead.phone, msg),
                                    { attempts: 3, delayMs: 1000 }
                                );
                                waSent = true;
                            }
                        } catch (waErr) {
                            console.warn(`[FollowupCron] WA failed for ${lead.id}:`, waErr.message);
                        }

                        // ── TRY Email ────────────────────────────────────────────────────────
                        try {
                            const emailAddr = sanitizeLeadEmailForPublic(lead.email);
                            if (assessment.canEmail && emailAddr) {
                                const isFirstMessage = currentIndex === 0;
                                const subject = isFirstMessage ? 'Thanks for reaching out!' : `Follow-up from ${lead.company_name || 'Our Team'}`;

                                await retryAsync(
                                    () =>
                                        sendDynamicEmail(lead.user_id, {
                                            to: emailAddr,
                                            subject: subject,
                                            text: msg,
                                            html: createEmailTemplate(msg, lead.full_name, subject),
                                        }),
                                    { attempts: 3, delayMs: 1000 }
                                );
                                emailSent = true;
                            }
                        } catch (mailErr) {
                            console.warn(`[FollowupCron] Email failed for ${lead.id}:`, mailErr.message);
                        }

                        return { lead, waSent, emailSent, stepIndex: currentIndex };
                    } catch (innerErr) {
                        console.warn(`[FollowupCron] Lead ${lead.id} failed:`, innerErr.message);
                        return {
                            lead,
                            waSent: false,
                            emailSent: false,
                            stepIndex: lead.followup_step_index || 0,
                        };
                    }
                })
            );
        } catch (batchErr) {
            console.error('[FollowupCron] Batch aborted:', batchErr.message);
            await pool.query(
                `UPDATE leads SET followup_status = 'pending', updated_at = NOW() WHERE id = ANY($1::uuid[])`,
                [leadIds]
            );
            return;
        }

        const successful = results.filter((r) => r.waSent || r.emailSent);
        const failed = results.filter((r) => !r.waSent && !r.emailSent);

        if (successful.length > 0) {
            const successIds = successful.map((r) => r.lead.id);
            const channelDetail = (wa, em) =>
                `${wa && em ? 'WA & Email' : wa ? 'WA' : em ? 'Email' : 'none'}`;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    `UPDATE leads
                     SET followup_step_index = followup_step_index + 1,
                         last_followup_at = NOW(),
                         followup_status = 'pending',
                         lead_status = 'Contacted',
                         updated_at = NOW()
                     WHERE id = ANY($1::uuid[])`,
                    [successIds]
                );
                for (const r of successful) {
                    const detail = `Follow-up sent via ${channelDetail(r.waSent, r.emailSent)}`;
                    await client.query(
                        `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                        [
                            r.lead.user_id,
                            'Lead Follow-up',
                            `Sequence Step ${r.stepIndex + 1}`,
                            'Success',
                            detail,
                            JSON.stringify({
                                lead_name: r.lead.full_name,
                                step: r.stepIndex + 1,
                                waSent: r.waSent,
                                emailSent: r.emailSent,
                            }),
                        ]
                    );
                }
                await client.query('COMMIT');
            } catch (txnErr) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) {
                    /* noop */
                }
                console.error('[FollowupCron] Success-path transaction failed:', txnErr.message);
                await pool.query(
                    `UPDATE leads SET followup_status = 'pending', updated_at = NOW() WHERE id = ANY($1::uuid[])`,
                    [leadIds]
                );
                return;
            } finally {
                client.release();
            }
        }

        if (failed.length > 0) {
            try {
                const failedIds = failed.map((r) => r.lead.id);
                await pool.query(
                    `UPDATE leads
                     SET followup_status = 'pending',
                         last_followup_at = NOW(),
                         updated_at = NOW()
                     WHERE id = ANY($1::uuid[])`,
                    [failedIds],
                );
                for (const r of failed) {
                    await insertActivityLog({
                        userId: r.lead.user_id,
                        automationName: 'Lead Follow-up',
                        triggerType: `Sequence Step ${(r.stepIndex || 0) + 1}`,
                        status: 'Failed',
                        detail: 'Follow-up could not be sent — check WhatsApp and Gmail under Integrations.',
                        metadata: {
                            lead_id: r.lead.id,
                            lead_name: r.lead.full_name,
                            wa_attempted: r.lead.whatsapp_enabled !== false,
                            email_attempted: r.lead.email_enabled !== false,
                        },
                    });
                }
                const byUser = new Map();
                for (const r of failed) {
                    byUser.set(r.lead.user_id, (byUser.get(r.lead.user_id) || 0) + 1);
                }
                for (const [uid, count] of byUser) {
                    if (!shouldSendFollowupFailureAlert(uid)) {
                        console.log(
                            `[FollowupCron] Suppressed duplicate admin alert for user ${uid} (${count} failure(s))`,
                        );
                        continue;
                    }
                    notifyAdminFireAndForget({
                        subject: `[Equipo Experto] ${count} follow-up(s) failed (user ${uid})`,
                        text:
                            `${count} automated follow-up message(s) could not be sent for user ${uid}. ` +
                            `The workspace likely needs WhatsApp and/or Gmail connected under Integrations. ` +
                            `Retries are spaced at least ${FOLLOWUP_RETRY_COOLDOWN_MIN} minutes apart. ` +
                            `Check Dashboard → Activity and Integrations.`,
                    });
                }
            } catch (resetFailErr) {
                console.error('[FollowupCron] Could not reset failed leads:', resetFailErr.message);
            }
        }

        console.log(`[FollowupCron] ✅ Batch complete: ${successful.length} sent, ${failed.length} failed`);
    };

    // ── Main Poll Loop ─────────────────────────────────────────────────────────
    setInterval(async () => {
        try {
            const stuckRes = await pool.query(
                `UPDATE leads SET followup_status = 'pending', updated_at = NOW()
                 WHERE followup_status = 'processing'
                   AND updated_at < NOW() - ($1::bigint * INTERVAL '1 minute')
                 RETURNING id`,
                [STUCK_PROCESSING_AFTER_MIN]
            );
            if (stuckRes.rowCount > 0) {
                console.warn(
                    `[FollowupCron] Reset ${stuckRes.rowCount} lead(s) stuck in processing (>${STUCK_PROCESSING_AFTER_MIN}m)`
                );
            }

            // Run Gmail reply check periodically (every 5 minutes)
            if (new Date().getMinutes() % 5 === 0) {
                checkGmailReplies();
            }

            // Get ALL leads that need follow-up (not just 50)
            const query = `
                SELECT 
                    l.id, l.user_id, l.full_name, l.phone, l.email, l.created_at, l.last_followup_at, l.followup_step_index,
                    s.followup_sequence, s.whatsapp_enabled, s.email_enabled,
                    rfs.automation_id,
                    u.company_name
                FROM leads l
                JOIN users u ON l.user_id = u.id
                JOIN lead_followup_settings s ON l.user_id = s.user_id
                LEFT JOIN review_funnel_settings rfs ON l.user_id = rfs.user_id
                WHERE s.is_active = true
                  AND (l.lead_status = 'New' OR l.lead_status = 'Contacted')
                  AND (l.followup_status IS NULL OR l.followup_status != 'processing')
                  AND l.followup_step_index < jsonb_array_length(s.followup_sequence)
            `;
            const result = await pool.query(query);

            // Filter to only leads whose scheduled time has passed
            const dueLeads = result.rows.filter((lead) => {
                const sequence = parseFollowupSequence(lead.followup_sequence);
                if (sequence.length === 0) return true;

                const currentIndex = lead.followup_step_index || 0;
                if (currentIndex >= sequence.length) return false;

                const nextStep = sequence[currentIndex];
                const lastAt = lead.last_followup_at || lead.created_at;
                const lastMs = new Date(lastAt).getTime();

                const retryReadyAt = lastMs + FOLLOWUP_RETRY_COOLDOWN_MIN * 60 * 1000;
                if (Date.now() < retryReadyAt) {
                    return false;
                }

                // If last_followup_at is far in the past (like our -1 year hack), it's due IMMEDIATELY
                if (lastMs < Date.now() - 30 * 24 * 60 * 60 * 1000) {
                    return true;
                }

                const scheduledTime = getScheduledTime(lastAt, nextStep.delay_value, nextStep.delay_unit);
                return new Date() >= scheduledTime;
            });

            if (dueLeads.length > 0) {
                await processBatch(dueLeads);
            }
        } catch (err) {
            console.error('[FollowupCron] Poll Error:', err.message);
        }
    }, 60000); // Check every minute
};

export default startFollowupCron;
