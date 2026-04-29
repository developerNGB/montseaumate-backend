import pool from '../db/pool.js';
import fetch from 'node-fetch';
import { getValidGoogleToken } from '../utils/googleAuth.js';
import { injectPlaceholders } from '../utils/templateUtils.js';
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
 * Create professional HTML email template
 */
const createEmailTemplate = (message, leadName) => {
    const currentYear = new Date().getFullYear();
    // Use provided name or just "there" - don't extract from email
    const greetingName = leadName && leadName !== 'Imported Lead' ? leadName : 'there';
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5; }
        .email-wrapper { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { padding: 40px 30px; text-align: center; border-bottom: 3px solid #3b82f6; }
        .header h1 { margin: 0; color: #1f2937; font-size: 24px; font-weight: 600; }
        .content { padding: 40px 30px; }
        .content p { margin: 0 0 20px 0; color: #4b5563; font-size: 16px; line-height: 1.7; }
        .message-box { background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0; }
        .message-box p { margin: 0; color: #374151; }
        .signature { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
        .signature p { margin: 0; color: #6b7280; font-size: 14px; }
        .footer { padding: 30px; text-align: center; background-color: #f9fafb; border-top: 1px solid #e5e7eb; }
        .footer p { margin: 0; color: #9ca3af; font-size: 12px; }
        .button { display: inline-block; padding: 12px 24px; background-color: #3b82f6; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="email-wrapper">
        <div class="header">
            <h1>Follow-up from Our Team</h1>
        </div>
        <div class="content">
            <p>Hi ${greetingName},</p>
            <div class="message-box">
                <p>${message.replace(/\n/g, '</p><p>')}</p>
            </div>
            <div class="signature">
                <p>Best regards,<br>Customer Success Team</p>
            </div>
        </div>
        <div class="footer">
            <p>This email was sent to you as part of our follow-up service.<br>© ${currentYear} All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
};

/**
 * Dispatch a follow-up message to a single lead.
 * Priority: Email (primary) → WhatsApp native → n8n (fallback).
 * Never throws — logs errors and continues.
 * @param {string} subject - Optional custom subject line
 */
const dispatchFollowup = async (userId, lead, message, subject = 'Follow-up from Our Team') => {
    // Name handling: use provided name, or extract from email, or fallback to "there"
    const leadName = lead.full_name && lead.full_name !== 'there' && lead.full_name !== 'Imported Lead'
        ? lead.full_name
        : extractNameFromEmail(lead.email) || 'there';
    
    const personalisedMsg = (message || 'Hi {name}! Just following up on your enquiry.')
        .replace(/\{name\}/gi, leadName)
        .replace(/\{NAME\}/g, leadName);

    console.log(`[Followup] Dispatching to ${lead.email || lead.phone || 'unknown'} (ID: ${lead.id || 'new'}, Name: ${leadName})`);

    // 1. EMAIL (Primary) - via emailService cascade: SMTP → Microsoft → Google → system gmail
    if (lead.email) {
        try {
            console.log(`[Followup] 📧 Attempting email to ${lead.email}...`);
            const result = await sendDynamicEmail(userId, {
                to: lead.email,
                subject: subject,
                text: personalisedMsg,
                html: createEmailTemplate(personalisedMsg, leadName),
            });
            console.log(`[Followup] ✅ Email sent to ${lead.email} via ${result.provider || 'unknown provider'}`);
            return 'email';
        } catch (e) {
            console.error('[Followup] ❌ Email failed:', e.message);
            // Continue to next channel - don't return yet
        }
    }

    // 2. Native WhatsApp (Secondary)
    if (lead.phone) {
        try {
            const waInt = await pool.query(
                `SELECT access_token FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
                [userId]
            );
            if (waInt.rows[0]?.access_token === 'whatsapp_native_session') {
                await whatsappService.sendWhatsAppMessage(userId, lead.phone, personalisedMsg);
                console.log(`[Followup] ✅ WhatsApp sent to ${lead.phone}`);
                return 'whatsapp';
            }
            console.log(`[Followup] WhatsApp not connected for user ${userId}`);
        } catch (e) {
            console.warn('[Followup] WhatsApp failed:', e.message);
        }
    }

    // 3. n8n webhook (Tertiary/Fallback)
    const webhookUrl = process.env.N8N_LEAD_FOLLOWUP_WEBHOOK;
    if (webhookUrl) {
        try {
            console.log(`[Followup] Attempting n8n webhook...`);
            const r = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'followup', lead, message: personalisedMsg }),
                timeout: 8000,
            });
            if (r.ok) { 
                console.log(`[Followup] ✅ n8n triggered for ${lead.email || lead.phone}`); 
                return 'n8n'; 
            }
        } catch (e) {
            console.warn('[Followup] n8n failed:', e.message);
        }
    }

    console.warn(`[Followup] ❌ No channel available for lead ${lead.id || lead.email || lead.phone}`);
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

        // 1. Dedup within batch by email+phone (whichever present)
        const seen = new Set();
        const batchUnique = leads.filter(l => {
            const emailKey = (l.email || '').toLowerCase().trim();
            const phoneKey = (l.phone || '').replace(/\D/g, '');
            const key = emailKey || phoneKey;
            if (!key) return true; // name-only lead — keep
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

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
            pool.query(`SELECT auto_response_message, lead_capture_active FROM review_funnel_settings WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] })),
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
        const newLeads = batchUnique.filter(l => {
            const email = (l.email || '').toLowerCase().trim();
            const phone = (l.phone || '').replace(/\D/g, '');
            if (email && existingEmails.has(email)) return false;
            if (phone && existingPhones.has(phone)) return false;
            return true;
        });

        const skipped = leads.length - newLeads.length;

        if (newLeads.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'All contacts already exist — nothing new added',
                imported: 0,
                skipped: leads.length,
            });
        }

        // 4. Bulk INSERT — single DB round-trip via unnest()
        const lastFollowupAt = followupActive ? new Date().toISOString() : null;

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
        const actualSkipped = leads.length - savedLeads.length;

        // Respond immediately — messaging is fire-and-forget
        res.status(200).json({
            success: true,
            message: `${savedLeads.length} contacts imported`,
            imported: savedLeads.length,
            skipped: actualSkipped,
        });

        if (savedLeads.length === 0) return;

        // 5. Fire-and-forget capture auto-responses
        if (captureActive) {
            Promise.allSettled(
                savedLeads.filter(l => l.email || l.phone).map(lead =>
                    dispatchFollowup(userId, lead, captureCfg.auto_response_message, 'Thanks for reaching out!')
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
    try {
        const { id } = req.params;
        
        // Fetch lead and user config
        const query = `
            SELECT l.*, u.company_name, u.email as owner_email, rfs.auto_response_message, rfs.notification_email, rfs.whatsapp_number_fallback
            FROM leads l
            JOIN users u ON l.user_id = u.id
            LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
            WHERE l.id = $1 AND l.user_id = $2
        `;
        const leadResult = await pool.query(query, [id, req.user.id]);

        if (leadResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        const lead = leadResult.rows[0];

        // Fetch integration tokens
        const freshGoogleToken = await getValidGoogleToken(req.user.id);
        const integrationsResult = await pool.query(
            `SELECT provider, access_token, refresh_token, account_id FROM integrations WHERE user_id = $1`,
            [req.user.id]
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
        const microsoftAuth = integrations['microsoft'] || {};
        const whatsappAuth = integrations['whatsapp'] || {};
        const currentGoogleAccessToken = freshGoogleToken || googleAuth.access_token;

        // Fetch SMTP credentials for n8n
        const smtpRes = await pool.query(
            'SELECT host, port, secure, auth_user, auth_pass, from_email, from_name FROM smtp_settings WHERE user_id = $1 AND is_active = true',
            [req.user.id]
        );
        const smtp = smtpRes.rows[0] || {};

        const payload = {
            event: 'manual_followup',
            full_name: lead.full_name,
            email: lead.email,
            phone: lead.phone,
            notes: lead.notes,
            source: lead.source,
            business_name: lead.company_name,
            owner_email: lead.owner_email,
            notification_email: lead.notification_email || lead.owner_email,
            email: lead.notification_email || lead.owner_email, // Set 'email' as the alert email
            lead_email: lead.email, // Keep lead email as lead_email
            message: lead.message,
            auto_response_message: lead.auto_response_message,
            injected_message: injectPlaceholders(lead.auto_response_message, {
                name: lead.full_name,
                link: `${process.env.FRONTEND_URL}/r/${lead.automation_id || 'default'}`,
                number: integrations['whatsapp']?.account_id || lead.whatsapp_number_fallback || ''
            }),
            whatsapp_number: integrations['whatsapp']?.account_id || lead.whatsapp_number_fallback || '',

            // Integration tokens for n8n
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            access_token: currentGoogleAccessToken || null,
            refresh_token: googleAuth.refresh_token || null,
            microsoft_access_token: microsoftAuth.access_token || null,
            microsoft_refresh_token: microsoftAuth.refresh_token || null,
            whatsapp_access_token: whatsappAuth.access_token || null,
            whatsapp_refresh_token: whatsappAuth.refresh_token || null,
            // SMTP credentials
            smtp_host: smtp.host || null,
            smtp_port: smtp.port || null,
            smtp_secure: smtp.secure || false,
            smtp_user: smtp.auth_user || null,
            smtp_pass: smtp.auth_pass || null,
            smtp_from_email: smtp.from_email || null,
            smtp_from_name: smtp.from_name || null
        };

        // Dispatch via cascade: WhatsApp native → n8n → email
        const channel = await dispatchFollowup(req.user.id, lead, lead.auto_response_message);

        // Update status to Contacted
        await pool.query(
            `UPDATE leads SET lead_status = 'Contacted', updated_at = NOW() WHERE id = $1`,
            [id]
        );

        return res.status(200).json({ success: true, message: `Follow-up sent via ${channel}` });

    } catch (err) {
        console.error('[triggerLeadFollowup] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};


export const triggerBulkFollowup = async (req, res) => {
    try {
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
