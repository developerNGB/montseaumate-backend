import pool from '../db/pool.js';
import fetch from 'node-fetch';
import { getValidGoogleToken } from '../utils/googleAuth.js';
import { injectPlaceholders } from '../utils/templateUtils.js';
import * as whatsappService from '../services/whatsappService.js';
import { sendDynamicEmail } from '../services/emailService.js';

/**
 * Dispatch a follow-up message to a single lead.
 * Priority: WhatsApp native → n8n → email (via emailService cascade).
 * Never throws — logs errors and continues.
 */
const dispatchFollowup = async (userId, lead, message) => {
    const personalisedMsg = (message || 'Hi {name}! Just following up on your enquiry.')
        .replace(/\{name\}/gi, lead.full_name || 'there')
        .replace(/\{NAME\}/g,  lead.full_name || 'there');

    // 1. Native WhatsApp
    if (lead.phone) {
        try {
            const waInt = await pool.query(
                `SELECT access_token FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
                [userId]
            );
            if (waInt.rows[0]?.access_token === 'whatsapp_native_session') {
                await whatsappService.sendWhatsAppMessage(userId, lead.phone, personalisedMsg);
                console.log(`[Followup] WhatsApp sent to ${lead.phone}`);
                return 'whatsapp';
            }
        } catch (e) {
            console.warn('[Followup] WhatsApp failed:', e.message);
        }
    }

    // 2. n8n webhook
    const webhookUrl = process.env.N8N_LEAD_FOLLOWUP_WEBHOOK;
    if (webhookUrl) {
        try {
            const r = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'followup', lead, message: personalisedMsg }),
                timeout: 8000,
            });
            if (r.ok) { console.log(`[Followup] n8n triggered for ${lead.email || lead.phone}`); return 'n8n'; }
        } catch (e) {
            console.warn('[Followup] n8n failed:', e.message);
        }
    }

    // 3. Email fallback (emailService cascade: SMTP → Microsoft → Google → system gmail)
    if (lead.email) {
        try {
            await sendDynamicEmail(userId, {
                to: lead.email,
                subject: 'Following up on your enquiry',
                text: personalisedMsg,
                html: `<p style="font-family:sans-serif;line-height:1.6">${personalisedMsg.replace(/\n/g, '<br>')}</p>`,
            });
            console.log(`[Followup] Email sent to ${lead.email}`);
            return 'email';
        } catch (e) {
            console.warn('[Followup] Email failed:', e.message);
        }
    }

    console.warn(`[Followup] No channel available for lead ${lead.id || lead.email}`);
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

        const client = await pool.connect();
        let savedLeads = [];
        try {
            await client.query('BEGIN');
            for (const lead of uniqueLeads) {
                const result = await client.query(
                    `INSERT INTO leads (user_id, full_name, email, phone, notes, source, lead_status, marketing_consent, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, 'New', true, NOW())
                     ON CONFLICT DO NOTHING
                     RETURNING *`,
                    [
                        req.user.id,
                        lead.full_name || 'Imported Lead',
                        lead.email || '',
                        lead.phone || '',
                        lead.notes || '',
                        lead.source || 'Excel Upload',
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

        // Respond immediately — follow-up dispatch is async (fire-and-forget)
        res.status(200).json({ success: true, message: `${savedLeads.length} leads imported successfully` });

        // Trigger follow-up sequence for each saved lead (non-blocking)
        if (savedLeads.length > 0) {
            const cfgRes = await pool.query(
                `SELECT message, followup_sequence, is_active FROM lead_followup_settings WHERE user_id = $1`,
                [req.user.id]
            );
            const cfg = cfgRes.rows[0];
            if (cfg?.is_active) {
                const sequence = (typeof cfg.followup_sequence === 'string'
                    ? JSON.parse(cfg.followup_sequence)
                    : cfg.followup_sequence) || [];
                const firstMessage = sequence[0]?.message || cfg.message;

                // Fire-and-forget: don't await so response has already been sent
                Promise.allSettled(savedLeads.map(lead => dispatchFollowup(req.user.id, lead, firstMessage)))
                    .then(results => {
                        const counts = results.reduce((acc, r) => {
                            const ch = r.value || 'error';
                            acc[ch] = (acc[ch] || 0) + 1;
                            return acc;
                        }, {});
                        console.log(`[importLeads] Follow-up dispatch complete:`, counts);
                    });
            }
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
        const { source } = req.body;
        const cfgRes = await pool.query(
            `SELECT message, followup_sequence, is_active FROM lead_followup_settings WHERE user_id = $1`,
            [req.user.id]
        );
        const cfg = cfgRes.rows[0];
        if (!cfg?.is_active) {
            return res.status(200).json({ success: true, message: 'Follow-up agent is off duty' });
        }

        const sequence = (typeof cfg.followup_sequence === 'string'
            ? JSON.parse(cfg.followup_sequence)
            : cfg.followup_sequence) || [];
        const firstMessage = sequence[0]?.message || cfg.message;

        // Get leads imported in the last 10 minutes with status New
        const leadsRes = await pool.query(
            `SELECT * FROM leads WHERE user_id = $1 AND source = $2 AND lead_status = 'New' AND created_at > NOW() - INTERVAL '10 minutes'`,
            [req.user.id, source || 'bulk_import']
        );

        const leads = leadsRes.rows;
        res.status(200).json({ success: true, dispatching: leads.length });

        // Fire-and-forget dispatch
        Promise.allSettled(leads.map(lead => dispatchFollowup(req.user.id, lead, firstMessage)));
    } catch (err) {
        console.error('[triggerBulkFollowup] Error:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error' });
    }
};
