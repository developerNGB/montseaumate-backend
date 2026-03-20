import pool from '../db/pool.js';
import { getValidGoogleToken } from '../utils/googleAuth.js';
import { injectPlaceholders } from '../utils/templateUtils.js';
import * as whatsappService from '../services/whatsappService.js';

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
        const { leads } = req.body; // Array of lead objects
        if (!Array.isArray(leads)) {
            return res.status(400).json({ success: false, message: 'Invalid leads format' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const lead of leads) {
                await client.query(
                    `INSERT INTO leads (user_id, full_name, email, phone, notes, source, lead_status, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
                    [
                        req.user.id,
                        lead.full_name || 'Imported Lead',
                        lead.email || '',
                        lead.phone || '',
                        lead.notes || '',
                        lead.source || 'Excel Upload',
                        'New'
                    ]
                );
            }
            await client.query('COMMIT');
            return res.status(200).json({ success: true, message: `${leads.length} leads imported successfully` });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('[importLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const triggerLeadFollowup = async (req, res) => {
    try {
        const { id } = req.params;
        
        // Fetch lead and user config
        const leadResult = await pool.query(
            `SELECT l.*, u.company_name, u.email as owner_email, rfs.auto_response_message
             FROM leads l
             JOIN users u ON l.user_id = u.id
             LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
             WHERE l.id = $1 AND l.user_id = $2`,
            [id, req.user.id]
        );

        if (leadResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        const lead = leadResult.rows[0];

        // Fetch integration tokens
        const freshGoogleToken = await getValidGoogleToken(req.user.id);
        const integrationsResult = await pool.query(
            `SELECT provider, access_token, refresh_token FROM integrations WHERE user_id = $1`,
            [req.user.id]
        );

        const integrations = integrationsResult.rows.reduce((acc, curr) => {
            acc[curr.provider] = {
                access_token: curr.access_token,
                refresh_token: curr.refresh_token
            };
            return acc;
        }, {});

        const googleAuth = integrations['google'] || {};
        const whatsappAuth = integrations['whatsapp'] || {};
        const currentGoogleAccessToken = freshGoogleToken || googleAuth.access_token;

        const payload = {
            event: 'manual_followup',
            full_name: lead.full_name,
            email: lead.email,
            phone: lead.phone,
            notes: lead.notes,
            source: lead.source,
            business_name: lead.company_name,
            owner_email: lead.owner_email,
            message: lead.message,
            auto_response_message: lead.auto_response_message,
            injected_message: injectPlaceholders(lead.auto_response_message, {
                name: lead.full_name,
                link: `${process.env.FRONTEND_URL}/r/${lead.automation_id || 'default'}`
            }),

            // Integration tokens for n8n
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            access_token: currentGoogleAccessToken || null,
            refresh_token: googleAuth.refresh_token || null,
            whatsapp_access_token: whatsappAuth.access_token || null,
            whatsapp_refresh_token: whatsappAuth.refresh_token || null
        };

        // DIRECT NATIVE DISPATCH: Handled locally if it's a native session
        if (whatsappAuth.access_token === 'whatsapp_native_session') {
           try {
               await whatsappService.sendWhatsAppMessage(req.user.id, lead.phone, payload.injected_message);
               console.log(`[NativeFollowup] Sent manual followup message to ${lead.phone}`);
           } catch (dispatchErr) {
               console.error('[NativeFollowup] Failed:', dispatchErr.message);
               // We continue to fire the n8n webhook as a secondary/logging mechanism anyway
           }
        }

        const webhookUrl = process.env.N8N_LEAD_FOLLOWUP_WEBHOOK || "https://dataanalyst.app.n8n.cloud/webhook/review-feedback";
        
        const n8nRes = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!n8nRes.ok) throw new Error('n8n responded with error');

        // Update status to Contacted
        await pool.query(
            `UPDATE leads SET lead_status = 'Contacted', updated_at = NOW() WHERE id = $1`,
            [id]
        );

        return res.status(200).json({ success: true, message: 'Follow-up sequence triggered via n8n' });

    } catch (err) {
        console.error('[triggerLeadFollowup] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
