import pool from '../db/pool.js';
import crypto from 'crypto';
import qrcode from 'qrcode';

// GET /api/config/review-funnel
export const getReviewFunnelConfig = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT automation_id, google_review_url, notification_email, auto_response_message, filtering_questions, is_active, lead_capture_active FROM review_funnel_settings WHERE user_id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(200).json({ success: true, config: null });
        }

        const config = result.rows[0];
        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const publicUrl = `${baseUrl}/r/${config.automation_id}`;
        const leadUrl = `${baseUrl}/l/${config.automation_id}`;

        const qrCodeDataUrl = await qrcode.toDataURL(publicUrl);
        const leadQrCodeDataUrl = await qrcode.toDataURL(leadUrl);

        return res.status(200).json({
            success: true,
            config: { ...config, publicUrl, qrCodeDataUrl, leadUrl, leadQrCodeDataUrl }
        });
    } catch (err) {
        console.error('[getReviewFunnelConfig] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

// POST /api/config/review-funnel
export const saveReviewFunnelConfig = async (req, res) => {
    try {
        const { google_review_url, notification_email, auto_response_message, filtering_questions } = req.body;

        // Generate an automation ID if one doesn't exist
        const result = await pool.query('SELECT automation_id FROM review_funnel_settings WHERE user_id = $1', [req.user.id]);

        let automationId = result.rows.length > 0 ? result.rows[0].automation_id : crypto.randomBytes(4).toString('hex');

        await pool.query(
            `INSERT INTO review_funnel_settings 
                (user_id, automation_id, google_review_url, notification_email, auto_response_message, filtering_questions, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (user_id) DO UPDATE SET 
                google_review_url = EXCLUDED.google_review_url,
                notification_email = EXCLUDED.notification_email,
                auto_response_message = EXCLUDED.auto_response_message,
                filtering_questions = EXCLUDED.filtering_questions,
                updated_at = NOW()`,
            [req.user.id, automationId, google_review_url, notification_email, auto_response_message, JSON.stringify(filtering_questions || [])]
        );

        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const publicUrl = `${baseUrl}/r/${automationId}`;
        const leadUrl = `${baseUrl}/l/${automationId}`;

        const qrCodeDataUrl = await qrcode.toDataURL(publicUrl);
        const leadQrCodeDataUrl = await qrcode.toDataURL(leadUrl);

        return res.status(200).json({
            success: true,
            message: 'Review funnel settings saved successfully!',
            config: {
                automation_id: automationId,
                google_review_url,
                notification_email,
                auto_response_message,
                filtering_questions: filtering_questions || [],
                publicUrl,
                qrCodeDataUrl,
                leadUrl,
                leadQrCodeDataUrl
            }
        });

    } catch (err) {
        console.error('[saveReviewFunnelConfig] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

// GET /api/config/lead-followup
export const getLeadFollowupConfig = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT is_active, delay_value, delay_unit, message, reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message FROM lead_followup_settings WHERE user_id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(200).json({ success: true, config: null });
        }

        return res.status(200).json({ success: true, config: result.rows[0] });
    } catch (err) {
        console.error('[getLeadFollowupConfig] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

// POST /api/config/lead-followup
export const saveLeadFollowupConfig = async (req, res) => {
    try {
        const passed = req.body;

        // Fetch existing config first
        const existingRes = await pool.query(
            'SELECT is_active, delay_value, delay_unit, message, reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message FROM lead_followup_settings WHERE user_id = $1',
            [req.user.id]
        );
        const existing = existingRes.rows.length > 0 ? existingRes.rows[0] : {};

        // Merge inputs with existing (or defaults if new)
        const is_active = passed.is_active !== undefined ? passed.is_active : (existing.is_active ?? false);
        const delay_value = passed.delay_value !== undefined ? passed.delay_value : (existing.delay_value ?? 24);
        const delay_unit = passed.delay_unit !== undefined ? passed.delay_unit : (existing.delay_unit ?? 'hours');
        const message = passed.message !== undefined ? passed.message : (existing.message ?? 'Hey, just following up on your inquiry from yesterday. Are you still looking for help with this? Let me know!');

        const reminder_active = passed.reminder_active !== undefined ? passed.reminder_active : (existing.reminder_active ?? false);
        const reminder_delay_value = passed.reminder_delay_value !== undefined ? passed.reminder_delay_value : (existing.reminder_delay_value ?? 48);
        const reminder_delay_unit = passed.reminder_delay_unit !== undefined ? passed.reminder_delay_unit : (existing.reminder_delay_unit ?? 'hours');
        const reminder_message = passed.reminder_message !== undefined ? passed.reminder_message : (existing.reminder_message ?? 'Hi again! Just a friendly reminder about your inquiry. We haven\'t heard back and want to make sure you got our last message.');

        await pool.query(
            `INSERT INTO lead_followup_settings 
                (user_id, is_active, delay_value, delay_unit, message, 
                 reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
             ON CONFLICT (user_id) DO UPDATE SET 
                is_active = EXCLUDED.is_active,
                delay_value = EXCLUDED.delay_value,
                delay_unit = EXCLUDED.delay_unit,
                message = EXCLUDED.message,
                reminder_active = EXCLUDED.reminder_active,
                reminder_delay_value = EXCLUDED.reminder_delay_value,
                reminder_delay_unit = EXCLUDED.reminder_delay_unit,
                reminder_message = EXCLUDED.reminder_message,
                updated_at = NOW()`,
            [req.user.id, is_active, delay_value, delay_unit, message,
                reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message]
        );

        return res.status(200).json({
            success: true,
            message: 'Lead follow-up settings saved successfully!',
            config: {
                is_active, delay_value, delay_unit, message,
                reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message
            }
        });

    } catch (err) {
        console.error('[saveLeadFollowupConfig] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const toggleRecipe = async (req, res) => {
    try {
        const { recipe, is_active } = req.body;
        const userId = req.user.id;

        if (recipe === 'reviewFunnel') {
            await pool.query(
                `INSERT INTO review_funnel_settings (user_id, automation_id, google_review_url, notification_email, is_active)
                 VALUES ($1, md5(random()::text), '', '', $2)
                 ON CONFLICT (user_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
                [userId, is_active]
            );
        } else if (recipe === 'leadCapture') {
            await pool.query(
                `INSERT INTO review_funnel_settings (user_id, automation_id, google_review_url, notification_email, lead_capture_active)
                 VALUES ($1, md5(random()::text), '', '', $2)
                 ON CONFLICT (user_id) DO UPDATE SET lead_capture_active = EXCLUDED.lead_capture_active`,
                [userId, is_active]
            );
        } else if (recipe === 'leadFollowUp') {
            await pool.query(
                `INSERT INTO lead_followup_settings (user_id, is_active) 
                 VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
                [userId, is_active]
            );
        } else {
            return res.status(400).json({ success: false, message: 'Unknown recipe type.' });
        }

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[toggleRecipe] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
