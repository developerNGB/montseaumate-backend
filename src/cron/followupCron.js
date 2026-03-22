import pool from '../db/pool.js';
import fetch from 'node-fetch';
import { getValidGoogleToken } from '../utils/googleAuth.js';
import { injectPlaceholders } from '../utils/templateUtils.js';
import * as whatsappService from '../services/whatsappService.js';

const ensureProductionUrl = (url) => {
    // User requested move to production for all URLs
    return url;
};

const startFollowupCron = () => {
    console.log('🤖 Background Automation Started: Checking for all consented lead follow-ups...');

    const processLead = async (lead, isReminder = false) => {
        try {
            // Refresh token logic
            const freshGoogleToken = await getValidGoogleToken(lead.user_id);

            const integrationsResult = await pool.query(
                `SELECT provider, access_token, refresh_token, account_id FROM integrations WHERE user_id = $1`,
                [lead.user_id]
            );

            const integrations = integrationsResult.rows.reduce((acc, curr) => {
                acc[curr.provider] = {
                    access_token: curr.access_token,
                    refresh_token: curr.refresh_token,
                    account_id: curr.account_id
                };
                return acc;
            }, {});

            const googleAuth = integrations['google'] || {};
            const whatsappAuth = integrations['whatsapp'] || {};
            const currentGoogleAccessToken = freshGoogleToken || googleAuth.access_token;

            const baseUrl = process.env.FRONTEND_URL || 'https://montseaumateii.pages.dev';
            const whatsapp_number = whatsappAuth.account_id || lead.whatsapp_number_fallback || '';
            const link = `${baseUrl}/r/${lead.automation_id}`;

            const injectedMessage = injectPlaceholders(lead.custom_message, {
                name: lead.full_name,
                link: link,
                number: whatsapp_number
            });

            // 1. Direct WhatsApp Dispatch (Native)
            if (whatsappAuth.access_token === 'whatsapp_native_session' && lead.phone) {
                // Check session status BEFORE attempting — if still restoring, skip gracefully
                const sessionStatus = whatsappService.getSessionStatus(lead.user_id);
                if (sessionStatus.status === 'initializing' || sessionStatus.status === 'restoring') {
                    console.log(`[FollowupCron] ⏳ Session still restoring for user ${lead.user_id}. Skipping lead "${lead.full_name}" — will retry next cycle.`);
                    return; // Silent skip — lead stays pending, cron retries in 10s
                }
                if (sessionStatus.status !== 'connected') {
                    console.warn(`[FollowupCron] ⚠️ Session not connected (status: ${sessionStatus.status}). Skipping lead "${lead.full_name}".`);
                    return;
                }

                try {
                    await whatsappService.sendWhatsAppMessage(lead.user_id, lead.phone, injectedMessage);
                    console.log(`[FollowupCron] ✅ Native WhatsApp ${isReminder ? 'Reminder' : 'Followup'} sent to ${lead.phone}`);
                } catch (dispatchErr) {
                    // If it fails mid-send, log it but don't mark as failed — let it retry
                    console.error(`[FollowupCron] ❌ Native dispatch FAILED for "${lead.full_name}":`, dispatchErr.message);
                    return; // Retry next cycle
                }
            } else {
                console.warn(`[FollowupCron] ⚠️ Skipping lead "${lead.full_name}" — no native WhatsApp session configured.`);
                return;
            }

            // 2. Optional Notification Webhook
            const webhookUrl = process.env.N8N_LEAD_FOLLOWUP_WEBHOOK;
            if (webhookUrl) {
                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        event: isReminder ? 'lead_reminder' : 'lead_followup',
                        lead_id: lead.lead_id,
                        full_name: lead.full_name,
                        phone: lead.phone,
                        message: injectedMessage
                    })
                }).catch(e => {});
            }

            const followupStatusField = isReminder ? 'followup_status_reminder' : 'followup_status';

            // Mark Success
            await pool.query(
                `UPDATE leads SET ${followupStatusField} = 'success', lead_status = 'Contacted', updated_at = NOW() WHERE id = $1`,
                [lead.lead_id]
            );

            // 📝 LOG ACTIVITY: SUCCESS
            await pool.query(
                `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
                  VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [
                    lead.user_id,
                    isReminder ? 'Lead Reminder' : 'Lead Follow-up',
                    isReminder ? 'Scheduled Reminder' : 'Scheduled Followup',
                    'Success',
                    `${isReminder ? 'Reminder' : 'Follow-up'} sent to: ${lead.full_name}`,
                    JSON.stringify({
                        lead_name: lead.full_name,
                        lead_email: lead.lead_email,
                        message_sent: injectedMessage
                    })
                ]
            );

            console.log(`[FollowupCron] 🚀 ${isReminder ? 'Reminder' : 'Followup'} marked success in DB for: ${lead.full_name}`);
        } catch (webhookErr) {
            console.error('[FollowupCron] Webhook connection failed for lead', lead.lead_id, webhookErr.message);
        }
    };

    // Run every 10 seconds
    setInterval(async () => {
        try {
            // 1. Process PRIMARY Follow-ups (Now including HISTORICAL leads with consent)
            const primaryResult = await pool.query(`
                SELECT 
                    l.id as lead_id,
                    l.user_id,
                    l.full_name,
                    l.email as lead_email,
                    l.phone,
                    l.message as original_message,
                    l.created_at as captured_date,
                    s.delay_value,
                    s.delay_unit,
                    s.message as custom_message,
                    u.email as owner_email,
                    rfs.automation_id,
                    rfs.whatsapp_number_fallback
                FROM leads l
                JOIN lead_followup_settings s ON l.user_id = s.user_id
                JOIN users u ON l.user_id = u.id
                LEFT JOIN review_funnel_settings rfs ON l.user_id = rfs.user_id
                WHERE s.is_active = true 
                  AND l.marketing_consent = true
                  AND LOWER(l.lead_status) = 'new'
                  AND (l.followup_status = 'pending' OR l.followup_status = 'failed' OR l.followup_status IS NULL)
                  AND NOW() >= (
                      l.created_at + 
                      (s.delay_value * CASE 
                          WHEN LOWER(s.delay_unit) = 'seconds' THEN interval '1 second' 
                          WHEN LOWER(s.delay_unit) = 'minutes' THEN interval '1 minute' 
                          WHEN LOWER(s.delay_unit) = 'days' THEN interval '1 day' 
                          ELSE interval '1 hour' 
                      END)
                  )
            `);

            const pendingCount = primaryResult.rows.length;
            if (pendingCount > 0) {
                console.log(`[FollowupCron] 📋 Found ${pendingCount} PRIMARY leads matching follow-up criteria.`);
            }

            for (const lead of primaryResult.rows) {
                console.log(`[FollowupCron] 🔄 Processing PRIMARY follow-up for lead: ${lead.full_name} (${lead.lead_id})`);
                await processLead(lead, false);
            }

            // 2. Process SECONDARY Reminders (Also including HISTORICAL leads)
            const reminderResult = await pool.query(`
                SELECT 
                    l.id as lead_id,
                    l.user_id,
                    l.full_name,
                    l.email as lead_email,
                    l.phone,
                    l.message as original_message,
                    l.created_at as captured_date,
                    s.reminder_delay_value as delay_value,
                    s.reminder_delay_unit as delay_unit,
                    s.reminder_message as custom_message,
                    u.email as owner_email,
                    rfs.automation_id,
                    rfs.whatsapp_number_fallback
                FROM leads l
                JOIN lead_followup_settings s ON l.user_id = s.user_id
                JOIN users u ON l.user_id = u.id
                LEFT JOIN review_funnel_settings rfs ON l.user_id = rfs.user_id
                WHERE s.reminder_active = true 
                  AND l.marketing_consent = true
                  AND l.followup_status = 'success'
                  AND (l.followup_status_reminder = 'pending' OR l.followup_status_reminder = 'failed' OR l.followup_status_reminder IS NULL)
                  AND NOW() >= (
                      l.created_at + 
                      (s.reminder_delay_value * CASE 
                          WHEN LOWER(s.reminder_delay_unit) = 'seconds' THEN interval '1 second' 
                          WHEN LOWER(s.reminder_delay_unit) = 'minutes' THEN interval '1 minute' 
                          WHEN LOWER(s.reminder_delay_unit) = 'days' THEN interval '1 day' 
                          ELSE interval '1 hour' 
                      END)
                  )
            `);

            const reminderCount = reminderResult.rows.length;
            if (reminderCount > 0) {
                console.log(`[FollowupCron] 📋 Found ${reminderCount} SECONDARY reminder leads matching criteria.`);
            }

            for (const lead of reminderResult.rows) {
                console.log(`[FollowupCron] 🔄 Processing SECONDARY reminder for lead: ${lead.full_name} (${lead.lead_id})`);
                await processLead(lead, true);
            }

        } catch (err) {
            console.error('[FollowupCron] Error querying database:', err.message);
        }
    }, 10 * 1000); // Check every 10 seconds
};

export default startFollowupCron;
