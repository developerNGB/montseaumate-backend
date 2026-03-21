import pool from '../db/pool.js';
import crypto from 'crypto';
import qrcode from 'qrcode';

// GET /api/config/review-funnel
export const getReviewFunnelConfig = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT automation_id, google_review_url, notification_email, auto_response_message, filtering_questions, is_active, lead_capture_active, whatsapp_number_fallback FROM review_funnel_settings WHERE user_id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(200).json({ success: true, config: null });
        }

        const config = result.rows[0];
        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        
        // Survey Funnel (New Multi-Rating System)
        const surveyUrl = `${baseUrl}/f/${config.automation_id}`;
        const surveyQrCode = await qrcode.toDataURL(surveyUrl);

        // Google Review Funnel (Legacy/Direct)
        const reviewUrl = `${baseUrl}/r/${config.automation_id}`;
        const reviewQrCode = await qrcode.toDataURL(reviewUrl);
        
        const leadUrl = `${baseUrl}/l/${config.automation_id}`;
        const leadQrCode = await qrcode.toDataURL(leadUrl);

        return res.status(200).json({
            success: true,
            config: { 
                ...config, 
                lead_capture_active: config.lead_capture_active,
                whatsapp_number_fallback: config.whatsapp_number_fallback,
                publicUrl: surveyUrl, 
                qrCodeDataUrl: surveyQrCode,
                surveyUrl,
                surveyQrCode,
                reviewUrl,
                reviewQrCode,
                leadUrl,
                leadQrCode
            }
        });
    } catch (err) {
        console.error('[getReviewFunnelConfig] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

// POST /api/config/review-funnel
export const saveReviewFunnelConfig = async (req, res) => {
    try {
        const { google_review_url, notification_email, auto_response_message, filtering_questions, lead_capture_active, whatsapp_number_fallback } = req.body;

        // Generate an automation ID if one doesn't exist
        const result = await pool.query('SELECT automation_id FROM review_funnel_settings WHERE user_id = $1', [req.user.id]);

        let automationId = result.rows.length > 0 ? result.rows[0].automation_id : crypto.randomBytes(4).toString('hex');

        await pool.query(
            `INSERT INTO review_funnel_settings 
                (user_id, automation_id, google_review_url, notification_email, auto_response_message, filtering_questions, lead_capture_active, whatsapp_number_fallback, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (user_id) DO UPDATE SET 
                google_review_url = EXCLUDED.google_review_url,
                notification_email = EXCLUDED.notification_email,
                auto_response_message = EXCLUDED.auto_response_message,
                filtering_questions = EXCLUDED.filtering_questions,
                lead_capture_active = EXCLUDED.lead_capture_active,
                whatsapp_number_fallback = EXCLUDED.whatsapp_number_fallback,
                updated_at = NOW()`,
            [req.user.id, automationId, google_review_url, notification_email, auto_response_message, JSON.stringify(filtering_questions || []), lead_capture_active || false, whatsapp_number_fallback || '']
        );

        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const surveyUrl = `${baseUrl}/f/${automationId}`;
        const surveyQrCode = await qrcode.toDataURL(surveyUrl);
        const reviewUrl = `${baseUrl}/r/${automationId}`;
        const reviewQrCode = await qrcode.toDataURL(reviewUrl);
        const leadUrl = `${baseUrl}/l/${automationId}`;
        const leadQrCode = await qrcode.toDataURL(leadUrl);

        return res.status(200).json({
            success: true,
            message: 'Review funnel settings saved successfully!',
            config: {
                automation_id: automationId,
                google_review_url,
                notification_email,
                auto_response_message,
                filtering_questions: filtering_questions || [],
                lead_capture_active,
                whatsapp_number_fallback,
                publicUrl: surveyUrl, 
                qrCodeDataUrl: surveyQrCode,
                surveyUrl,
                surveyQrCode,
                reviewUrl,
                reviewQrCode,
                leadUrl,
                leadQrCode
            }
        });

    } catch (err) {
        console.error('[saveReviewFunnelConfig] CRITICAL ERR:', err);
        return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
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

export const deleteAutomation = async (req, res) => {
    try {
        const { recipe, deleteRelatedData, deleteLogs } = req.body;
        const userId = req.user.id;

        if (recipe === 'reviewFunnel') {
            // Update the flag. If leadCapture is also inactive, we might delete the whole settings row
            // but for safety and preserving the automation_id (URLs), we usually just deactivate.
            // However, the user wants to "Delete", which implies a reset.
            
            // Get current state to see if leadCapture is active
            const current = await pool.query('SELECT lead_capture_active FROM review_funnel_settings WHERE user_id = $1', [userId]);
            const isLeadCaptureActive = current.rows.length > 0 ? current.rows[0].lead_capture_active : false;

            if (isLeadCaptureActive) {
                // Just reset review funnel fields
                await pool.query(
                    `UPDATE review_funnel_settings SET 
                        is_active = false, 
                        google_review_url = '', 
                        notification_email = '', 
                        auto_response_message = '',
                        filtering_questions = '[]',
                        updated_at = NOW() 
                     WHERE user_id = $1`,
                    [userId]
                );
            } else {
                // Both are inactive/deleted or only review funnel existed
                await pool.query('DELETE FROM review_funnel_settings WHERE user_id = $1', [userId]);
            }

            if (deleteRelatedData) {
                await pool.query('DELETE FROM feedback WHERE user_id = $1', [userId]);
            }
        } 
        else if (recipe === 'leadCapture') {
            const current = await pool.query('SELECT is_active FROM review_funnel_settings WHERE user_id = $1', [userId]);
            const isReviewFunnelActive = current.rows.length > 0 ? current.rows[0].is_active : false;

            if (isReviewFunnelActive) {
                await pool.query(
                    `UPDATE review_funnel_settings SET 
                        lead_capture_active = false, 
                        updated_at = NOW() 
                     WHERE user_id = $1`,
                    [userId]
                );
            } else {
                await pool.query('DELETE FROM review_funnel_settings WHERE user_id = $1', [userId]);
            }

            if (deleteRelatedData) {
                // Delete leads from this specific user? 
                // Careful: leadFollowUp might depend on them. 
                // But the user specifically asked for "Related triggers / logs / captured data"
                await pool.query("DELETE FROM leads WHERE user_id = $1 AND source ILIKE '%Capture%'", [userId]);
            }
        } 
        else if (recipe === 'leadFollowUp') {
            await pool.query('DELETE FROM lead_followup_settings WHERE user_id = $1', [userId]);
            
            if (deleteRelatedData) {
                // If they delete lead follow-up, maybe they want to clear lead follow-up statuses on leads?
                // Or delete leads? Usually "captured data" implies the leads themselves.
                await pool.query('DELETE FROM leads WHERE user_id = $1', [userId]);
            }
        } else {
            return res.status(400).json({ success: false, message: 'Unknown automation type.' });
        }

        if (deleteLogs) {
            // Map recipe key to log friendly name
            const logNameMap = {
                reviewFunnel: 'Review Funnel',
                leadCapture: 'Lead Capture',
                leadFollowUp: 'Lead Follow-up'
            };
            const automationName = logNameMap[recipe];
            await pool.query('DELETE FROM activity_logs WHERE user_id = $1 AND automation_name = $2', [userId, automationName]);
        }

        return res.status(200).json({ success: true, message: 'Automation deleted successfully.' });
    } catch (err) {
        console.error('[deleteAutomation] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
