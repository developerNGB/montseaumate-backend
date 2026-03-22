import pool from '../db/pool.js';
import { injectPlaceholders } from '../utils/templateUtils.js';
import * as whatsappService from '../services/whatsappService.js';

const startFollowupCron = () => {
    console.log('🤖 Follow-up Cron Started: max 1 primary + 1 reminder per lead.');

    const processLead = async (lead, isReminder = false) => {
        const followupField = isReminder ? 'followup_status_reminder' : 'followup_status';
        const label         = isReminder ? 'REMINDER' : 'PRIMARY';

        // ── STEP 1: CLAIM the lead atomically ────────────────────────────────
        // Set 'processing' immediately so the next 30s cycle ignores this lead.
        // If another cycle already claimed it, rowCount=0 → bail out safely.
        const claim = await pool.query(
            `UPDATE leads
                SET ${followupField} = 'processing', updated_at = NOW()
              WHERE id = $1
                AND (${followupField} IS NULL OR ${followupField} = 'pending')
              RETURNING id`,
            [lead.lead_id]
        );
        if (claim.rowCount === 0) {
            console.log(`[FollowupCron] ⏭️  Lead "${lead.full_name}" already claimed — skipping.`);
            return;
        }
        console.log(`[FollowupCron] 🔒 Claimed ${label} for: ${lead.full_name} (${lead.lead_id})`);

        // ── STEP 2: Check WhatsApp session ────────────────────────────────────
        const intRes = await pool.query(
            `SELECT access_token, account_id FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
            [lead.user_id]
        );
        const waAuth = intRes.rows[0] || {};

        if (waAuth.access_token !== 'whatsapp_native_session' || !lead.phone) {
            console.warn(`[FollowupCron] ⚠️  No native WhatsApp for "${lead.full_name}". Marking failed (no retry).`);
            await pool.query(
                `UPDATE leads SET ${followupField} = 'failed', updated_at = NOW() WHERE id = $1`,
                [lead.lead_id]
            );
            return;
        }

        const sessionStatus = whatsappService.getSessionStatus(lead.user_id);
        if (sessionStatus.status !== 'connected') {
            // Release the claim → lead retries on next cycle once session is live
            console.log(`[FollowupCron] ⏳ Session ${sessionStatus.status} — releasing claim for "${lead.full_name}". Will retry.`);
            await pool.query(
                `UPDATE leads SET ${followupField} = 'pending', updated_at = NOW() WHERE id = $1`,
                [lead.lead_id]
            );
            return;
        }

        // ── STEP 3: Build & Send message ──────────────────────────────────────
        const baseUrl = process.env.FRONTEND_URL || 'https://montseaumateii.pages.dev';
        const link    = `${baseUrl}/r/${lead.automation_id || ''}`;
        const msg     = injectPlaceholders(lead.custom_message || '', {
            name:   lead.full_name,
            link:   link,
            number: waAuth.account_id || ''
        });

        try {
            await whatsappService.sendWhatsAppMessage(lead.user_id, lead.phone, msg);
            console.log(`[FollowupCron] ✅ ${label} sent → ${lead.phone} for "${lead.full_name}"`);
        } catch (sendErr) {
            console.error(`[FollowupCron] ❌ Send FAILED for "${lead.full_name}":`, sendErr.message);
            // Mark failed — NOT retried because 'failed' is excluded from WHERE clause
            await pool.query(
                `UPDATE leads SET ${followupField} = 'failed', updated_at = NOW() WHERE id = $1`,
                [lead.lead_id]
            );
            return;
        }

        // ── STEP 4: Mark success ───────────────────────────────────────────────
        await pool.query(
            `UPDATE leads
                SET ${followupField} = 'success',
                    lead_status      = 'Contacted',
                    updated_at       = NOW()
              WHERE id = $1`,
            [lead.lead_id]
        );

        // ── STEP 5: Activity log ──────────────────────────────────────────────
        await pool.query(
            `INSERT INTO activity_logs
                (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
             VALUES ($1, $2, $3, 'Success', $4, $5, NOW())`,
            [
                lead.user_id,
                isReminder ? 'Lead Reminder' : 'Lead Follow-up',
                isReminder ? 'Scheduled Reminder' : 'Scheduled Followup',
                `${isReminder ? 'Reminder' : 'Follow-up'} sent to: ${lead.full_name}`,
                JSON.stringify({ lead_name: lead.full_name, phone: lead.phone, message_sent: msg })
            ]
        );

        console.log(`[FollowupCron] 🚀 ${label} complete for: ${lead.full_name}`);
    };

    // ── Poll every 30 seconds ─────────────────────────────────────────────────
    setInterval(async () => {
        try {

            // PRIMARY: only New leads, only if never sent (NULL or pending)
            const primary = await pool.query(`
                SELECT
                    l.id            AS lead_id,
                    l.user_id,
                    l.full_name,
                    l.email         AS lead_email,
                    l.phone,
                    l.created_at    AS captured_date,
                    s.delay_value,
                    s.delay_unit,
                    s.message       AS custom_message,
                    rfs.automation_id,
                    rfs.whatsapp_number_fallback
                FROM leads l
                JOIN lead_followup_settings s   ON l.user_id = s.user_id
                JOIN users u                    ON l.user_id = u.id
                LEFT JOIN review_funnel_settings rfs ON l.user_id = rfs.user_id
                WHERE s.is_active         = true
                  AND l.marketing_consent = true
                  AND LOWER(l.lead_status) = 'new'
                  AND (l.followup_status IS NULL OR l.followup_status = 'pending')
                  AND NOW() >= (
                      l.created_at +
                      s.delay_value * CASE LOWER(s.delay_unit)
                          WHEN 'seconds' THEN INTERVAL '1 second'
                          WHEN 'minutes' THEN INTERVAL '1 minute'
                          WHEN 'days'    THEN INTERVAL '1 day'
                          ELSE                INTERVAL '1 hour'
                      END
                  )
                LIMIT 20
            `);

            if (primary.rows.length > 0) {
                console.log(`[FollowupCron] 📋 ${primary.rows.length} PRIMARY lead(s) ready.`);
            }
            for (const lead of primary.rows) {
                console.log(`[FollowupCron] 🔄 PRIMARY → ${lead.full_name} (${lead.lead_id})`);
                await processLead(lead, false);
            }

            // SECONDARY: only if primary was already sent (success), reminder not sent yet
            const reminder = await pool.query(`
                SELECT
                    l.id            AS lead_id,
                    l.user_id,
                    l.full_name,
                    l.email         AS lead_email,
                    l.phone,
                    l.created_at    AS captured_date,
                    s.reminder_delay_value  AS delay_value,
                    s.reminder_delay_unit   AS delay_unit,
                    s.reminder_message      AS custom_message,
                    rfs.automation_id,
                    rfs.whatsapp_number_fallback
                FROM leads l
                JOIN lead_followup_settings s   ON l.user_id = s.user_id
                JOIN users u                    ON l.user_id = u.id
                LEFT JOIN review_funnel_settings rfs ON l.user_id = rfs.user_id
                WHERE s.reminder_active      = true
                  AND l.marketing_consent     = true
                  AND l.followup_status        = 'success'
                  AND (l.followup_status_reminder IS NULL OR l.followup_status_reminder = 'pending')
                  AND NOW() >= (
                      l.created_at +
                      s.reminder_delay_value * CASE LOWER(s.reminder_delay_unit)
                          WHEN 'seconds' THEN INTERVAL '1 second'
                          WHEN 'minutes' THEN INTERVAL '1 minute'
                          WHEN 'days'    THEN INTERVAL '1 day'
                          ELSE                INTERVAL '1 hour'
                      END
                  )
                LIMIT 20
            `);

            if (reminder.rows.length > 0) {
                console.log(`[FollowupCron] 📋 ${reminder.rows.length} SECONDARY reminder(s) ready.`);
            }
            for (const lead of reminder.rows) {
                console.log(`[FollowupCron] 🔄 REMINDER → ${lead.full_name} (${lead.lead_id})`);
                await processLead(lead, true);
            }

        } catch (err) {
            console.error('[FollowupCron] ❌ DB query error:', err.message);
        }
    }, 30 * 1000);
};

export default startFollowupCron;
