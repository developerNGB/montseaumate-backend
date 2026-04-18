import pool from '../db/pool.js';
import { injectPlaceholders } from '../utils/templateUtils.js';
import * as whatsappService from '../services/whatsappService.js';

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

const startFollowupCron = () => {
    console.log('🤖 Automated Follow-up Cron (Multi-Sequence) Started');

    const processSequenceStep = async (lead, step, index) => {
        try {
            // ── STEP 1: CLAIM the lead atomically ────────────────────────────────
            const claim = await pool.query(
                `UPDATE leads
                    SET followup_status = 'processing', updated_at = NOW()
                  WHERE id = $1
                    AND (followup_status IS NULL OR followup_status != 'processing')
                  RETURNING id`,
                [lead.id]
            );
            
            if (claim.rowCount === 0) return;

            // ── STEP 2: Check WhatsApp session ────────────────────────────────────
            const intRes = await pool.query(
                `SELECT access_token, account_id FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
                [lead.user_id]
            );
            const waAuth = intRes.rows[0] || {};

            if (waAuth.access_token !== 'whatsapp_native_session' || !lead.phone) {
                console.warn(`[FollowupCron] ⚠️ No WA session for lead ${lead.id}. Marking failed.`);
                await pool.query(
                    `UPDATE leads SET followup_status = 'failed', updated_at = NOW() WHERE id = $1`,
                    [lead.id]
                );
                return;
            }

            const sessionStatus = whatsappService.getSessionStatus(lead.user_id);
            if (sessionStatus.status !== 'connected') {
                // Release claim for retry
                await pool.query(
                    `UPDATE leads SET followup_status = 'pending', updated_at = NOW() WHERE id = $1`,
                    [lead.id]
                );
                return;
            }

            // ── STEP 3: Build & Send message ──────────────────────────────────────
            const baseUrl = process.env.FRONTEND_URL || 'https://www.equipoexperto.com';
            const link    = `${baseUrl}/r/${lead.automation_id || ''}`;
            const msg     = injectPlaceholders(step.message || '', {
                name:   lead.full_name,
                link:   link,
                number: waAuth.account_id || ''
            });

            await whatsappService.sendWhatsAppMessage(lead.user_id, lead.phone, msg);

            // ── STEP 4: Update Lead State ─────────────────────────────────────────
            // Increment the index and set last_followup_at
            await pool.query(
                `UPDATE leads
                    SET followup_step_index = followup_step_index + 1,
                        last_followup_at    = NOW(),
                        followup_status     = 'pending',
                        lead_status         = 'Contacted',
                        updated_at          = NOW()
                  WHERE id = $1`,
                [lead.id]
            );

            // ── STEP 5: Activity log ──────────────────────────────────────────────
            await pool.query(
                `INSERT INTO activity_logs
                    (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
                 VALUES ($1, $2, $3, 'Success', $4, $5, NOW())`,
                [
                    lead.user_id,
                    'Lead Follow-up',
                    `Sequence Step ${index + 1}`,
                    `Follow-up #${index + 1} sent to: ${lead.full_name}`,
                    JSON.stringify({ lead_name: lead.full_name, phone: lead.phone, step: index + 1, message: msg })
                ]
            );

            console.log(`[FollowupCron] ✅ Step ${index + 1} sent to ${lead.full_name}`);

        } catch (err) {
            console.error(`[FollowupCron] ❌ Process step failed for lead ${lead.id}:`, err.message);
            await pool.query(
                `UPDATE leads SET followup_status = 'failed', updated_at = NOW() WHERE id = $1`,
                [lead.id]
            );
        }
    };

    // ── Main Poll Loop ────────────────────────────────────────────────────────
    setInterval(async () => {
        try {
            // Fetch potential leads: ONLY "New" status, only if marketing_consent is true
            // Also ensures the user's automation is active.
            const query = `
                SELECT 
                    l.id, l.user_id, l.full_name, l.phone, l.created_at, l.last_followup_at, l.followup_step_index,
                    s.is_active as settings_active, s.followup_sequence,
                    rfs.automation_id
                FROM leads l
                JOIN lead_followup_settings s ON l.user_id = s.user_id
                LEFT JOIN review_funnel_settings rfs ON l.user_id = rfs.user_id
                WHERE s.is_active = true
                  -- Include New leads (starting) and Contacted leads (mid-sequence)
                  AND (l.lead_status = 'New' OR l.lead_status = 'Contacted')
                  AND (l.followup_status IS NULL OR l.followup_status != 'processing')
                  -- Only pull leads that haven't finished their sequence yet
                  AND l.followup_step_index < jsonb_array_length(s.followup_sequence)
                LIMIT 50
            `;
            const result = await pool.query(query);

            for (const lead of result.rows) {
                const sequence = typeof lead.followup_sequence === 'string' 
                    ? JSON.parse(lead.followup_sequence) 
                    : (lead.followup_sequence || []);
                
                if (sequence.length === 0) continue;

                const currentIndex = lead.followup_step_index || 0;
                if (currentIndex >= sequence.length) continue;

                const nextStep = sequence[currentIndex];
                const lastAt = lead.last_followup_at || lead.created_at;
                
                const scheduledTime = getScheduledTime(lastAt, nextStep.delay_value, nextStep.delay_unit);
                
                if (new Date() >= scheduledTime) {
                    console.log(`[FollowupCron] 🚀 Triggering Step ${currentIndex + 1} for ${lead.full_name}`);
                    await processSequenceStep(lead, nextStep, currentIndex);
                }
            }

        } catch (err) {
            console.error('[FollowupCron] ❌ Poll loop error:', err.message);
        }
    }, 60 * 1000); // Check every minute
};

export default startFollowupCron;
