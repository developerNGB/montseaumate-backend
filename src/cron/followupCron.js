import pool from '../db/pool.js';
import fetch from 'node-fetch';
import { getValidGoogleToken } from '../utils/googleAuth.js';
import { injectPlaceholders } from '../utils/templateUtils.js';

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

            const baseUrl = process.env.FRONTEND_URL || 'https://montseaumate-ii-fe.pages.dev';
            const whatsapp_number = whatsappAuth.account_id || lead.whatsapp_number_fallback || '';
            const link = `${baseUrl}/r/${lead.automation_id}`;

            const injectedMessage = injectPlaceholders(lead.custom_message, {
                name: lead.full_name,
                link: link,
                number: whatsapp_number
            });

            // PRODUCTION WEBHOOK URLs (tested and verified by user)
            const webhookUrl = ensureProductionUrl(process.env.N8N_LEAD_FOLLOWUP_WEBHOOK || 'https://dataanalyst.app.n8n.cloud/webhook/lead-followup');
            
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lead_id: lead.lead_id,
                    is_reminder: isReminder,
                    automation_id: lead.automation_id,
                    "Automation ID": lead.automation_id,
                    owner_email: lead.owner_email,
                    full_name: lead.full_name,
                    email: lead.lead_email,
                    phone: lead.phone,
                    original_message: lead.original_message,
                    captured_date: lead.captured_date,
                    delay_value: lead.delay_value,
                    delay_unit: lead.delay_unit,
                    whatsapp_number: whatsapp_number,
                    custom_message: injectedMessage, 
                    injected_message: injectedMessage,

                    // Integration tokens for n8n
                    client_id: process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    access_token: currentGoogleAccessToken || null,
                    refresh_token: googleAuth.refresh_token || null,
                    whatsapp_access_token: whatsappAuth.access_token || null,
                    whatsapp_refresh_token: whatsappAuth.refresh_token || null,

                    timestamp: new Date().toISOString()
                })
            });

            const followupStatusField = isReminder ? 'followup_status_reminder' : 'followup_status';

            if (response.ok || response.status === 200) {
                // Update BOTH followup_status AND lead_status (to 'Contacted')
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
                            owner_email: lead.owner_email,
                            lead_name: lead.full_name,
                            lead_email: lead.lead_email,
                            delay: `${lead.delay_value} ${lead.delay_unit}`,
                            message_sent: injectedMessage
                        })
                    ]
                );

                console.log(`[FollowupCron] 🚀 ${isReminder ? 'Reminder' : 'Followup'} sent successfully for lead: ${lead.full_name}`);
            } else {
                console.log(`[FollowupCron] ⚠️ Webhook returned ${response.status} for lead: ${lead.full_name}. Will retry later.`);
                
                // If it's NOT a 404, we can mark it as failed, but user asked to keep running until contacted
                // So we just update the timestamp to avoid tight-loops
                await pool.query(
                    `UPDATE leads SET updated_at = NOW() WHERE id = $1`,
                    [lead.lead_id]
                );
            }
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

            for (const lead of primaryResult.rows) {
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

            for (const lead of reminderResult.rows) {
                await processLead(lead, true);
            }

        } catch (err) {
            console.error('[FollowupCron] Error querying database:', err.message);
        }
    }, 10 * 1000); // Check every 10 seconds
};

export default startFollowupCron;
