import pool from '../db/pool.js';
import { injectPlaceholders, createEmailTemplate } from '../utils/templateUtils.js';
import * as whatsappService from '../services/whatsappService.js';
import { sendDynamicEmail } from '../services/emailService.js';

/**
 * Extract a name from email address (e.g., info@company.com → Info, john.smith@email.com → John Smith)
 */
const extractNameFromEmail = (email) => {
    if (!email) return null;
    const localPart = email.split('@')[0];
    // Remove numbers and split by common separators
    const parts = localPart.replace(/[0-9]/g, '').split(/[._\-]/).filter(p => p.length > 1);
    if (parts.length === 0) return null;
    // Capitalize each part
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
};

/**
 * Dispatch a follow-up message to a single lead.
 * Priority: WhatsApp native → email cascade. No external automation service.
 * Never throws — logs errors and continues.
 * @param {string} subject - Optional custom subject line
 */
const dispatchFollowup = async (userId, lead, message, subject = 'Message from Our Team', options = {}) => {
    const dispatchStart = Date.now();
    const whatsappEnabled = options.whatsappEnabled !== false;
    const emailEnabled = options.emailEnabled !== false;
    // Name handling: use provided name, or extract from email, or fallback to "there"
    const leadName = lead.full_name && lead.full_name !== 'there' && lead.full_name !== 'Imported Lead'
        ? lead.full_name
        : extractNameFromEmail(lead.email) || 'there';
    
    // Get automation/funnel ID if available for the link
    const link = lead.automation_id 
        ? `${process.env.FRONTEND_URL || 'https://www.equipoexperto.com'}/r/${lead.automation_id}`
        : (process.env.FRONTEND_URL || 'https://www.equipoexperto.com');

    const personalisedMsg = injectPlaceholders(message || 'Hi {name}! Thanks for reaching out.', {
        name: leadName,
        full_name: leadName,
        link: link,
        reviewUrl: link,
        googleReviewUrl: lead.google_review_url,
        company: lead.company_name || 'Our Team'
    });

    console.log(`[Followup][${dispatchStart}] Dispatching to ${lead.email || lead.phone || 'unknown'} (ID: ${lead.id || 'new'}, Name: ${leadName})`);

    const sentChannels = [];

    // 1. Native WhatsApp
    if (whatsappEnabled && lead.phone) {
        try {
            console.log(`[Followup][${Date.now() - dispatchStart}ms] 📱 Attempting WhatsApp to ${lead.phone}...`);
            const waInt = await pool.query(
                `SELECT access_token FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
                [userId]
            );
            if (waInt.rows[0]?.access_token === 'whatsapp_native_session') {
                await whatsappService.sendWhatsAppMessage(userId, lead.phone, personalisedMsg);
                console.log(`[Followup][${Date.now() - dispatchStart}ms] ✅ WhatsApp sent`);
                sentChannels.push('whatsapp');
            }
        } catch (e) {
            console.warn(`[Followup][${Date.now() - dispatchStart}ms] WhatsApp failed:`, e.message);
        }
    }

    // 2. Email - via emailService cascade: SMTP → Microsoft → Google → system gmail
    if (emailEnabled && lead.email) {
        try {
            console.log(`[Followup][${Date.now() - dispatchStart}ms] 📧 Attempting email to ${lead.email}...`);
            const result = await sendDynamicEmail(userId, {
                to: lead.email,
                subject: subject,
                text: personalisedMsg,
                html: createEmailTemplate(personalisedMsg, leadName, subject),
            });
            console.log(`[Followup][${Date.now() - dispatchStart}ms] ✅ Email sent via ${result.provider || 'unknown'}`);
            sentChannels.push(result.provider || 'email');
        } catch (e) {
            console.error(`[Followup][${Date.now() - dispatchStart}ms] ❌ Email failed:`, e.message);
            if (sentChannels.length === 0 && (e.message.includes('expired') || e.message.includes('permission') || e.message.includes('Invalid recipient'))) {
                throw e;
            }
        }
    }

    if (sentChannels.length > 0) {
        return sentChannels.join('+');
    }

    console.warn(`[Followup][${Date.now() - dispatchStart}ms] ❌ No channel available for lead ${lead.id || lead.email || lead.phone}`);
    return 'none';
};

export const getLeads = async (req, res) => {
    try {
        const { search, source, status, startDate, endDate } = req.query;
        let query = `SELECT * FROM leads WHERE user_id = $1`;
        const params = [req.user.id];
        let paramIndex = 2;

        if (search) {
            query += ` AND (full_name ILIKE $${paramIndex} OR email ILIKE $${paramIndex} OR phone ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (source) {
            query += ` AND source = $${paramIndex}`;
            params.push(source);
            paramIndex++;
        }

        if (status) {
            query += ` AND lead_status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (startDate) {
            query += ` AND created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        query += ` ORDER BY created_at DESC`;

        const result = await pool.query(query, params);
        return res.status(200).json({ success: true, leads: result.rows });
    } catch (err) {
        console.error('[getLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const updateLeadStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { lead_status, notes } = req.body;

        const result = await pool.query(
            `UPDATE leads 
             SET lead_status = COALESCE($1, lead_status), 
                 notes = COALESCE($2, notes),
                 updated_at = NOW()
             WHERE id = $3 AND user_id = $4
             RETURNING *`,
            [lead_status, notes, id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        return res.status(200).json({ success: true, lead: result.rows[0] });
    } catch (err) {
        console.error('[updateLeadStatus] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const importLeads = async (req, res) => {
    try {
        const { leads, skipCapture } = req.body;
        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ success: false, message: 'No leads provided' });
        }

        const userId = req.user.id;

        // 1. Dedup within batch — mark as duplicate if email matches OR phone matches
        const seenEmail = new Set();
        const seenPhone = new Set();
        let fileDups = 0;
        console.log(`[importLeads] Starting within-file dedup for ${leads.length} leads`);
        const batchUnique = leads.filter(l => {
            const emailKey = (l.email || '').toLowerCase().trim();
            const phoneKey = (l.phone || '').replace(/\D/g, '');
            // Check if this lead matches any previously seen (by email OR phone)
            if (emailKey && seenEmail.has(emailKey)) { 
                console.log(`[importLeads] File dup found by email: ${emailKey}`);
                fileDups++; 
                return false; 
            }
            if (phoneKey && seenPhone.has(phoneKey)) { 
                console.log(`[importLeads] File dup found by phone: ${phoneKey}`);
                fileDups++; 
                return false; 
            }
            // Track both keys for this lead
            if (emailKey) seenEmail.add(emailKey);
            if (phoneKey) seenPhone.add(phoneKey);
            return true;
        });
        console.log(`[importLeads] Within-file dedup: ${leads.length} → ${batchUnique.length} unique, ${fileDups} duplicates`);

        // 2. Fetch automation configs + check existing duplicates — all in parallel
        const batchEmails = batchUnique.map(l => (l.email || '').toLowerCase().trim()).filter(Boolean);
        const batchPhones = batchUnique.map(l => (l.phone || '').replace(/\D/g, '')).filter(Boolean);

        const dupConditions = [];
        const dupParams = [userId];
        if (batchEmails.length > 0) {
            dupParams.push(batchEmails);
            dupConditions.push(`(email != '' AND lower(email) = ANY($${dupParams.length}))`);
        }
        if (batchPhones.length > 0) {
            dupParams.push(batchPhones);
            dupConditions.push(`(phone != '' AND regexp_replace(phone, '[^0-9]', '', 'g') = ANY($${dupParams.length}))`);
        }

        const [captureRes, followupRes, existingRes] = await Promise.all([
            pool.query(`SELECT auto_response_message, google_review_url, lead_capture_active, automation_id, whatsapp_enabled, email_enabled FROM review_funnel_settings WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] })),
            pool.query(`SELECT is_active FROM lead_followup_settings WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] })),
            dupConditions.length > 0
                ? pool.query(
                    `SELECT lower(email) AS email, regexp_replace(phone, '[^0-9]', '', 'g') AS phone
                     FROM leads WHERE user_id = $1 AND (${dupConditions.join(' OR ')})`,
                    dupParams
                ).catch(() => ({ rows: [] }))
                : Promise.resolve({ rows: [] }),
        ]);

        const captureCfg = captureRes.rows[0];
        const followupActive = followupRes.rows[0]?.is_active;
        const captureActive = !skipCapture && captureCfg?.lead_capture_active && captureCfg?.auto_response_message;

        const existingEmails = new Set(existingRes.rows.map(r => r.email).filter(Boolean));
        const existingPhones = new Set(existingRes.rows.map(r => r.phone).filter(Boolean));

        // 3. Filter out DB duplicates
        let dbDups = 0;
        console.log(`[importLeads] Checking ${batchUnique.length} leads against DB. Existing emails: ${existingEmails.size}, phones: ${existingPhones.size}`);
        const newLeads = batchUnique.filter(l => {
            const email = (l.email || '').toLowerCase().trim();
            const phone = (l.phone || '').replace(/\D/g, '');
            if (email && existingEmails.has(email)) { 
                console.log(`[importLeads] DB dup found by email: ${email}`);
                dbDups++; 
                return false; 
            }
            if (phone && existingPhones.has(phone)) { 
                console.log(`[importLeads] DB dup found by phone: ${phone}`);
                dbDups++; 
                return false; 
            }
            return true;
        });
        console.log(`[importLeads] After DB dedup: ${batchUnique.length} → ${newLeads.length} new, ${dbDups} DB duplicates`);

        if (newLeads.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'All contacts already exist — nothing new added',
                imported: 0,
                fileDups,
                dbDups,
                total: leads.length,
            });
        }

        // 4. Bulk INSERT — single DB round-trip via unnest()
        // Logic for scheduling follow-ups:
        // - If we are sending a "Lead Capture" message now (captureActive), set last_followup_at = NOW()
        //   so that the cron job waits for the first follow-up delay before sending.
        // - If we are NOT sending a capture message (captureActive=false), set last_followup_at = 1 year ago
        //   so that the cron job picks up the first follow-up message IMMEDIATELY.
        const lastFollowupAt = followupActive 
            ? (captureActive 
                ? new Date().toISOString() 
                : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString())
            : null;

        const names    = newLeads.map(l => l.full_name || extractNameFromEmail(l.email) || 'Imported Lead');
        const emails   = newLeads.map(l => (l.email || '').trim());
        const phones   = newLeads.map(l => (l.phone || '').trim());
        const notesArr = newLeads.map(l => l.notes || '');
        const sources  = newLeads.map(l => l.source || 'Imported');

        const insertRes = await pool.query(
            `INSERT INTO leads
                 (user_id, full_name, email, phone, notes, source, lead_status, marketing_consent, followup_step_index, last_followup_at, created_at)
             SELECT $1,
                    unnest($2::text[]),
                    unnest($3::text[]),
                    unnest($4::text[]),
                    unnest($5::text[]),
                    unnest($6::text[]),
                    'New', true, 0, $7, NOW()
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [userId, names, emails, phones, notesArr, sources, lastFollowupAt]
        );

        const savedLeads = insertRes.rows;

        // Respond immediately — messaging is fire-and-forget
        res.status(200).json({
            success: true,
            message: `${savedLeads.length} contacts imported`,
            imported: savedLeads.length,
            fileDups,
            dbDups,
            total: leads.length,
        });

        if (savedLeads.length === 0) return;

        // 5. Fire-and-forget capture auto-responses
        if (captureActive) {
            Promise.allSettled(
                savedLeads.filter(l => l.email || l.phone).map(lead =>
                    dispatchFollowup(userId, { ...lead, automation_id: captureCfg.automation_id, google_review_url: captureCfg.google_review_url }, captureCfg.auto_response_message, 'Thanks for reaching out!', {
                        whatsappEnabled: captureCfg.whatsapp_enabled,
                        emailEnabled: captureCfg.email_enabled,
                    })
                )
            ).then(results => {
                const sent = results.filter(x => x.status === 'fulfilled' && x.value !== 'none').length;
                console.log(`[importLeads] Auto-response: ${sent}/${savedLeads.length} sent`);
            });
        }

        if (followupActive) {
            console.log(`[importLeads] ${savedLeads.length} leads queued for follow-up cron`);
        }
    } catch (err) {
        console.error('[importLeads] Error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Import failed. Please try again.' });
        }
    }
};

export const triggerLeadFollowup = async (req, res) => {
    const startTime = Date.now();
    try {
        const { id } = req.params;
        
        // Fetch lead and ALL relevant user configs
        const query = `
            SELECT 
                l.*, 
                u.company_name, u.email as owner_email, 
                rfs.auto_response_message as funnel_msg, rfs.google_review_url, rfs.notification_email, rfs.whatsapp_number_fallback,
                lfs.followup_sequence, lfs.is_active as lfs_active,
                lfs.whatsapp_enabled as lfs_whatsapp_enabled,
                lfs.email_enabled as lfs_email_enabled
            FROM leads l
            JOIN users u ON l.user_id = u.id
            LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
            LEFT JOIN lead_followup_settings lfs ON lfs.user_id = u.id
            WHERE l.id = $1 AND l.user_id = $2
        `;
        const leadResult = await pool.query(query, [id, req.user.id]);

        if (leadResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        const lead = leadResult.rows[0];
        console.log(`[triggerLeadFollowup][${Date.now() - startTime}ms] Found lead ${id}`);

        // Determine which message to send
        let messageToSend = lead.funnel_msg; // Default to funnel auto-response
        
        const sequence = typeof lead.followup_sequence === 'string' 
            ? JSON.parse(lead.followup_sequence) 
            : (lead.followup_sequence || []);

        if (sequence.length > 0) {
            const currentIndex = lead.followup_step_index || 0;
            if (currentIndex < sequence.length) {
                messageToSend = sequence[currentIndex].message;
            }
        }

        if (!messageToSend) {
            messageToSend = 'Hi {name}! Thanks for reaching out.';
        }

        // Determine subject: First message vs follow-up
        const isFirstMessage = (lead.followup_step_index || 0) === 0;
        const subject = isFirstMessage ? 'Thanks for reaching out!' : `Follow-up from ${lead.company_name || 'Our Team'}`;

        // Dispatch via internal cascade only: WhatsApp native → email.
        const channel = await dispatchFollowup(req.user.id, lead, messageToSend, subject, {
            whatsappEnabled: lead.lfs_whatsapp_enabled,
            emailEnabled: lead.lfs_email_enabled,
        });

        // Update status and increment sequence index so cron picks up the NEXT one
        await pool.query(
            `UPDATE leads 
             SET lead_status = 'Contacted', 
                 followup_step_index = followup_step_index + 1, 
                 last_followup_at = NOW(), 
                 updated_at = NOW() 
             WHERE id = $1`,
            [id]
        );

        // Log activity
        await pool.query(
            `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, created_at)
             VALUES ($1, $2, $3, 'Success', $4, NOW())`,
            [req.user.id, 'Lead Follow-up', 'Manual Trigger', 'Follow-up sent']
        );

        console.log(`[triggerLeadFollowup][${Date.now() - startTime}ms] ✅ Success via ${channel}`);
        return res.status(200).json({ success: true, message: `Follow-up sent via ${channel}`, provider: channel });

    } catch (err) {
        console.error(`[triggerLeadFollowup][${Date.now() - startTime}ms] ❌ Error:`, err.message);
        return res.status(500).json({ success: false, message: 'Failed to send follow-up' });
    }
};

export const triggerBulkFollowup = async (req, res) => {
    try {
        const { ids } = req.body;
        
        // If IDs are provided, trigger for those specific leads
        if (Array.isArray(ids) && ids.length > 0) {
            const cfgRes = await pool.query(
                `SELECT message, followup_sequence, is_active FROM lead_followup_settings WHERE user_id = $1`,
                [req.user.id]
            );
            const cfg = cfgRes.rows[0];
            
            // Get leads
            const leadsRes = await pool.query(
                `SELECT * FROM leads WHERE user_id = $1 AND id = ANY($2)`,
                [req.user.id, ids]
            );

            const leads = leadsRes.rows;
            if (leads.length === 0) {
                return res.status(200).json({ success: true, message: 'No leads found', triggered: 0 });
            }

            // Update them to 'Contacted' and set last_followup_at
            await pool.query(
                `UPDATE leads SET 
                    lead_status = 'Contacted',
                    followup_step_index = followup_step_index + 1,
                    last_followup_at = NOW(),
                    updated_at = NOW() 
                 WHERE id = ANY($1) AND user_id = $2`,
                [leads.map(l => l.id), req.user.id]
            );

            // Log activity
            await pool.query(
                `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, created_at)
                 VALUES ($1, $2, $3, 'Success', $4, NOW())`,
                [req.user.id, 'Lead Follow-up', 'Bulk Trigger', `${leads.length} follow-up messages sent`]
            );

            return res.status(200).json({ 
                success: true, 
                message: `${leads.length} follow-ups sent`,
                triggered: leads.length 
            });
        }

        // Fallback to original logic (recent imports)
        const cfgRes = await pool.query(
            `SELECT message, followup_sequence, is_active FROM lead_followup_settings WHERE user_id = $1`,
            [req.user.id]
        );
        const cfg = cfgRes.rows[0];
        if (!cfg?.is_active) {
            return res.status(200).json({ success: true, message: 'Follow-up agent is off duty' });
        }

        // Get leads imported in the last 60 minutes with status New that haven't been scheduled yet
        const leadsRes = await pool.query(
            `SELECT * FROM leads WHERE user_id = $1 AND lead_status = 'New' 
             AND created_at > NOW() - INTERVAL '60 minutes' 
             AND last_followup_at IS NULL`,
            [req.user.id]
        );

        const leads = leadsRes.rows;
        if (leads.length === 0) {
            return res.status(200).json({ success: true, message: 'No new leads to schedule', scheduled: 0 });
        }

        // Schedule them for cron processing by setting last_followup_at = NOW()
        await pool.query(
            `UPDATE leads SET followup_step_index = 0, last_followup_at = NOW() 
             WHERE id = ANY($1) AND user_id = $2`,
            [leads.map(l => l.id), req.user.id]
        );

        res.status(200).json({ 
            success: true, 
            message: `${leads.length} leads scheduled for follow-up`,
            scheduled: leads.length 
        });

        console.log(`[triggerBulkFollowup] ${leads.length} leads scheduled. Cron will send first message immediately.`);
    } catch (err) {
        console.error('[triggerBulkFollowup] Error:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const deleteLead = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        // Verify the lead belongs to this user
        const checkRes = await pool.query(
            `SELECT id FROM leads WHERE id = $1 AND user_id = $2`,
            [id, userId]
        );

        if (checkRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        // Delete the lead
        await pool.query(`DELETE FROM leads WHERE id = $1`, [id]);

        return res.status(200).json({ success: true, message: 'Lead deleted successfully' });
    } catch (err) {
        console.error('[deleteLead] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error deleting lead' });
    }
};

export const bulkDeleteLeads = async (req, res) => {
    try {
        const { ids } = req.body;
        const userId = req.user.id;

        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid IDs array' });
        }

        // Delete leads that belong to this user
        const result = await pool.query(
            `DELETE FROM leads WHERE id = ANY($1) AND user_id = $2 RETURNING id`,
            [ids, userId]
        );

        return res.status(200).json({ 
            success: true, 
            message: `${result.rowCount} leads deleted successfully`,
            deletedCount: result.rowCount
        });
    } catch (err) {
        console.error('[bulkDeleteLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error deleting leads' });
    }
};
