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
        const { leads } = req.body;
        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid leads format' });
        }

        // Deduplicate by email within this batch (extra server-side safety)
        const seen = new Set();
        const uniqueLeads = leads.filter(l => {
            const key = (l.email || '').toLowerCase().trim();
            if (key && seen.has(key)) return false;
            if (key) seen.add(key);
            return true;
        });

        // Check which automations are active before inserting
        const [captureRes, followupRes] = await Promise.all([
            pool.query(`SELECT auto_response_message, lead_capture_active FROM review_funnel_settings WHERE user_id = $1`, [req.user.id]).catch(() => ({ rows: [] })),
            pool.query(`SELECT message, followup_sequence, is_active FROM lead_followup_settings WHERE user_id = $1`, [req.user.id]).catch(() => ({ rows: [] }))
        ]);
        const captureCfg = captureRes.rows[0];
        const followupCfg = followupRes.rows[0];
        const followupActive = followupCfg?.is_active;
        const captureActive = captureCfg?.lead_capture_active && captureCfg?.auto_response_message;

        const client = await pool.connect();
        let savedLeads = [];
        try {
            await client.query('BEGIN');
            for (const lead of uniqueLeads) {
                // Determine initial followup state
                let followupStepIndex = 0;
                let lastFollowupAt = null;
                
                // If followup is active, set step to 0 and last_followup_at to NOW() 
                // so cron picks up first step immediately
                if (followupActive) {
                    lastFollowupAt = new Date().toISOString();
                }

                const result = await client.query(
                    `INSERT INTO leads (user_id, full_name, email, phone, notes, source, lead_status, marketing_consent, followup_step_index, last_followup_at, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, 'New', $7, $8, $9, NOW())
                     ON CONFLICT DO NOTHING
                     RETURNING *`,
                    [
                        req.user.id,
                        lead.full_name || extractNameFromEmail(lead.email) || 'there',
                        lead.email || '',
                        lead.phone || '',
                        lead.notes || '',
                        lead.source || 'Imported',
                        true, // marketing_consent = YES
                        followupStepIndex,
                        lastFollowupAt,
                    ]
                );
                if (result.rows[0]) savedLeads.push(result.rows[0]);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        // Respond immediately — cron will handle all messaging
        res.status(200).json({ success: true, message: `${savedLeads.length} leads imported successfully` });

        if (savedLeads.length === 0) return;

        // Fire-and-forget: Send capture auto-responses immediately (non-blocking)
        if (captureActive) {
            console.log(`[importLeads] Sending auto-responses to ${savedLeads.length} leads...`);
            Promise.allSettled(
                savedLeads.filter(l => l.email || l.phone).map(lead =>
                    dispatchFollowup(req.user.id, lead, captureCfg.auto_response_message, 'Thanks for reaching out!')
                )
            ).then(r => {
                const successful = r.filter(x => x.status === 'fulfilled' && x.value !== 'none').length;
                console.log(`[importLeads] ✅ Auto-response complete: ${successful} sent`);
            });
        }

        // Follow-ups are now handled by cron - leads have followup_step_index=0 and last_followup_at=NOW()
        // Cron will pick them up within 10 seconds and send based on sequence schedule
        if (followupActive) {
            console.log(`[importLeads] ${savedLeads.length} leads queued for follow-up sequence. Cron will send first message immediately.`);
        }
    } catch (err) {
        console.error('[importLeads] Error:', err.message);
        // Only send error if headers not already sent
        if (!res.headersSent) {
            return res.status(500).json({ success: false, message: 'Server error' });
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
