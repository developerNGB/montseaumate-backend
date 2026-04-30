import pool from '../db/pool.js';
import { injectPlaceholders, createEmailTemplate } from '../utils/templateUtils.js';
import { getValidGoogleTokens } from '../utils/googleAuth.js';
import * as whatsappService from '../services/whatsappService.js';
import { sendDynamicEmail } from '../services/emailService.js';

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

                // Search for recent unread or replied messages from our leads
                // We'll look for messages received in the last 24 hours
                const query = 'is:unread OR is:inbox'; 
                const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=20`, {
                    headers: { 'Authorization': `Bearer ${access_token}` }
                });

                if (!response.ok) continue;
                const data = await response.json();
                if (!data.messages) continue;

                for (const msg of data.messages) {
                    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
                        headers: { 'Authorization': `Bearer ${access_token}` }
                    });
                    if (!msgRes.ok) continue;
                    const message = await msgRes.json();
                    
                    // Extract sender email
                    const fromHeader = message.payload.headers.find(h => h.name === 'From')?.value || '';
                    const leadEmail = fromHeader.match(/<(.+)>|(\S+@\S+)/)?.[1] || fromHeader.match(/<(.+)>|(\S+@\S+)/)?.[2];
                    
                    if (leadEmail) {
                        // If this email matches a lead for this user, mark them as Contacted
                        await pool.query(
                            `UPDATE leads SET lead_status = 'Contacted', updated_at = NOW() 
                             WHERE user_id = $1 AND lower(email) = $2 AND lead_status != 'Contacted'`,
                            [userId, leadEmail.toLowerCase()]
                        );
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
        
        console.log(`[FollowupCron] 📦 Processing batch of ${leads.length} leads simultaneously`);
        
        // Group leads by user_id for efficient WhatsApp session checks
        const waSessions = new Map();
        
        // Claim ALL leads first atomically
        const leadIds = leads.map(l => l.id);
        await pool.query(
            `UPDATE leads SET followup_status = 'processing', updated_at = NOW() 
             WHERE id = ANY($1) AND (followup_status IS NULL OR followup_status != 'processing')`,
            [leadIds]
        );

        // Process ALL leads in parallel (batch send)
        const results = await Promise.allSettled(leads.map(async (lead) => {
            const sequence = typeof lead.followup_sequence === 'string' 
                ? JSON.parse(lead.followup_sequence) 
                : (lead.followup_sequence || []);
            
            if (sequence.length === 0) return { lead, sent: false };

            const currentIndex = lead.followup_step_index || 0;
            const step = sequence[currentIndex];
            
            const baseUrl = process.env.FRONTEND_URL || 'https://www.equipoexperto.com';
            const link = `${baseUrl}/r/${lead.automation_id || ''}`;
            const msg = injectPlaceholders(step.message || '', {
                name: lead.full_name,
                link: link,
                company: lead.company_name || 'Our Company'
            });

            let waSent = false;
            let emailSent = false;

            // ── TRY WhatsApp ─────────────────────────────────────────────────────
            try {
                if (!waSessions.has(lead.user_id)) {
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
                if (session?.isNative && session?.session?.status === 'connected' && lead.phone) {
                    await whatsappService.sendWhatsAppMessage(lead.user_id, lead.phone, msg);
                    waSent = true;
                }
            } catch (waErr) {
                console.warn(`[FollowupCron] WA failed for ${lead.id}:`, waErr.message);
            }

            // ── TRY Email ────────────────────────────────────────────────────────
            try {
                if (lead.email) {
                    const isFirstMessage = currentIndex === 0;
                    const subject = isFirstMessage ? 'Thanks for reaching out!' : `Follow-up from ${lead.company_name || 'Our Team'}`;
                    
                    await sendDynamicEmail(lead.user_id, {
                        to: lead.email,
                        subject: subject,
                        text: msg,
                        html: createEmailTemplate(msg, lead.full_name, subject)
                    });
                    emailSent = true;
                }
            } catch (mailErr) {
                console.warn(`[FollowupCron] Email failed for ${lead.id}:`, mailErr.message);
            }

            return { lead, waSent, emailSent, msg, stepIndex: currentIndex };
        }));

        // ── Batch Update ALL leads ─────────────────────────────────────────────
        const successful = results.filter(r => r.status === 'fulfilled' && (r.value.waSent || r.value.emailSent));
        const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.waSent && !r.value.emailSent));

        // Update successful leads
        if (successful.length > 0) {
            const successIds = successful.map(r => r.value.lead.id);
            await pool.query(
                `UPDATE leads 
                 SET followup_step_index = followup_step_index + 1,
                     last_followup_at = NOW(),
                     followup_status = 'pending',
                     lead_status = 'Contacted',
                     updated_at = NOW()
                 WHERE id = ANY($1)`,
                [successIds]
            );

            // Bulk activity log
            const logValues = successful.map(r => [
                r.value.lead.user_id,
                'Lead Follow-up',
                `Sequence Step ${r.value.stepIndex + 1}`,
                `Follow-up sent via ${r.value.waSent ? 'WA' : ''}${r.value.waSent && r.value.emailSent ? ' & ' : ''}${r.value.emailSent ? 'Email' : ''}`,
                JSON.stringify({ lead_name: r.value.lead.full_name, step: r.value.stepIndex + 1, waSent: r.value.waSent, emailSent: r.value.emailSent }),
                `Follow-up sent` // detail field
            ]);
            
            for (const vals of logValues) {
                await pool.query(
                    `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
                     VALUES ($1, $2, $3, 'Success', $6, $5, NOW())`,
                    vals
                );
            }
        }

        // Update failed leads
        if (failed.length > 0) {
            const failedIds = failed.map(r => r.status === 'fulfilled' ? r.value.lead.id : null).filter(Boolean);
            if (failedIds.length > 0) {
                await pool.query(
                    `UPDATE leads SET followup_status = 'pending', updated_at = NOW() WHERE id = ANY($1)`,
                    [failedIds]
                );
            }
        }

        console.log(`[FollowupCron] ✅ Batch complete: ${successful.length} sent, ${failed.length} failed`);
    };

    // ── Main Poll Loop ─────────────────────────────────────────────────────────
    setInterval(async () => {
        try {
            // Run Gmail reply check periodically (every 5 minutes)
            if (new Date().getMinutes() % 5 === 0) {
                checkGmailReplies();
            }

            // Get ALL leads that need follow-up (not just 50)
            const query = `
                SELECT 
                    l.id, l.user_id, l.full_name, l.phone, l.email, l.created_at, l.last_followup_at, l.followup_step_index,
                    s.followup_sequence,
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
            const dueLeads = result.rows.filter(lead => {
                const sequence = typeof lead.followup_sequence === 'string' 
                    ? JSON.parse(lead.followup_sequence) 
                    : (lead.followup_sequence || []);
                if (sequence.length === 0) return false;
                
                const currentIndex = lead.followup_step_index || 0;
                if (currentIndex >= sequence.length) return false;
                
                const nextStep = sequence[currentIndex];
                const lastAt = lead.last_followup_at || lead.created_at;

                // If last_followup_at is far in the past (like our -1 year hack), it's due IMMEDIATELY
                if (new Date(lastAt) < new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) {
                    return true;
                }

                const scheduledTime = getScheduledTime(lastAt, nextStep.delay_value, nextStep.delay_unit);
                return new Date() >= scheduledTime;
            });

            if (dueLeads.length > 0) {
                processBatch(dueLeads);
            }
        } catch (err) {
            console.error('[FollowupCron] Poll Error:', err.message);
        }
    }, 60000); // Check every minute
};

export default startFollowupCron;
