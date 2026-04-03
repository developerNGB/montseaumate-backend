import pool from '../db/pool.js';
import crypto from 'crypto';
import qrcode from 'qrcode';

// GET /api/config/review-funnel
export const getReviewFunnelConfig = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT automation_id, google_review_url, notification_email, auto_response_message, filtering_questions, is_active, lead_capture_active, whatsapp_number_fallback, lead_source, capture_source, whatsapp_enabled, email_enabled FROM review_funnel_settings WHERE user_id = $1',
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
                leadQrCode,
                lead_source: config.lead_source || 'qr',
                capture_source: config.capture_source || 'qr',
                whatsapp_enabled: config.whatsapp_enabled ?? true,
                email_enabled: config.email_enabled ?? true
            }
        });
    } catch (err) {
        console.error('[getReviewFunnelConfig] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

// POST /api/config/review-funnel
export const saveReviewFunnelConfig = async (req, res) => {
    console.log('[saveReviewFunnelConfig] Received:', req.body);
    try {
        const { 
            google_review_url, notification_email, auto_response_message, 
            filtering_questions, lead_capture_active, is_active, 
            whatsapp_number_fallback, lead_source, capture_source,
            whatsapp_enabled, email_enabled
        } = req.body;

        // Generate an automation ID if one doesn't exist
        const result = await pool.query('SELECT automation_id FROM review_funnel_settings WHERE user_id = $1', [req.user.id]);
        let automationId = result.rows.length > 0 ? result.rows[0].automation_id : crypto.randomBytes(4).toString('hex');

        const validatedLeadSource = (lead_source === 'qr' || lead_source === 'excel' || lead_source === 'website') ? lead_source : (req.body.goal === 'capture' ? undefined : 'qr');
        const validatedCaptureSource = (capture_source === 'qr' || capture_source === 'excel' || capture_source === 'website') ? capture_source : (req.body.goal === 'review' ? undefined : 'qr');

        // Get existing to avoid overwrites if not provided
        const existingConfigRes = await pool.query('SELECT * FROM review_funnel_settings WHERE user_id = $1', [req.user.id]);
        const existingConfig = existingConfigRes.rows[0] || {};

        const finalLeadSource = validatedLeadSource || existingConfig.lead_source || 'qr';
        const finalCaptureSource = validatedCaptureSource || existingConfig.capture_source || 'qr';

        // CRITICAL: Each goal only controls its own flag — never touch the other engine's flag
        let finalReviewActive, finalCaptureActive;
        if (req.body.goal === 'capture') {
            // Only update Lead Capture flag; preserve Review Funnel's existing state
            finalReviewActive = existingConfig.is_active ?? false;
            finalCaptureActive = lead_capture_active !== undefined ? lead_capture_active : (existingConfig.lead_capture_active ?? false);
        } else {
            // Only update Review Funnel flag; preserve Lead Capture's existing state
            finalReviewActive = is_active !== undefined ? is_active : (existingConfig.is_active ?? false);
            finalCaptureActive = existingConfig.lead_capture_active ?? false;
        }

        await pool.query(
            `INSERT INTO review_funnel_settings 
                (user_id, automation_id, google_review_url, notification_email, auto_response_message, filtering_questions, lead_capture_active, is_active, whatsapp_number_fallback, lead_source, capture_source, whatsapp_enabled, email_enabled, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
             ON CONFLICT (user_id) DO UPDATE SET 
                google_review_url = EXCLUDED.google_review_url,
                notification_email = EXCLUDED.notification_email,
                auto_response_message = EXCLUDED.auto_response_message,
                filtering_questions = EXCLUDED.filtering_questions,
                lead_capture_active = EXCLUDED.lead_capture_active,
                is_active = EXCLUDED.is_active,
                whatsapp_number_fallback = EXCLUDED.whatsapp_number_fallback,
                lead_source = EXCLUDED.lead_source,
                capture_source = EXCLUDED.capture_source,
                whatsapp_enabled = EXCLUDED.whatsapp_enabled,
                email_enabled = EXCLUDED.email_enabled,
                updated_at = NOW()`,
            [
                req.user.id, automationId, 
                google_review_url !== undefined ? google_review_url : existingConfig.google_review_url || '', 
                notification_email !== undefined ? notification_email : existingConfig.notification_email || '', 
                auto_response_message !== undefined ? auto_response_message : existingConfig.auto_response_message || '', 
                JSON.stringify(filtering_questions || existingConfig.filtering_questions || []), 
                finalCaptureActive, 
                finalReviewActive, 
                whatsapp_number_fallback !== undefined ? whatsapp_number_fallback : existingConfig.whatsapp_number_fallback || '', 
                finalLeadSource, finalCaptureSource,
                whatsapp_enabled !== undefined ? whatsapp_enabled : (existingConfig.whatsapp_enabled ?? true),
                email_enabled !== undefined ? email_enabled : (existingConfig.email_enabled ?? true)
            ]
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
                leadQrCode,
                lead_source: finalLeadSource,
                capture_source: finalCaptureSource
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
            'SELECT is_active, delay_value, delay_unit, message, reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source, whatsapp_enabled, email_enabled, followup_sequence FROM lead_followup_settings WHERE user_id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(200).json({ success: true, config: null });
        }

        const config = result.rows[0];
        return res.status(200).json({ 
            success: true, 
            config: {
                ...config,
                followup_sequence: typeof config.followup_sequence === 'string' ? JSON.parse(config.followup_sequence) : (config.followup_sequence || [])
            } 
        });
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
            'SELECT is_active, delay_value, delay_unit, message, reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source FROM lead_followup_settings WHERE user_id = $1',
            [req.user.id]
        );
        const existing = existingRes.rows.length > 0 ? existingRes.rows[0] : {};

        // Merge inputs with existing (or defaults if new)
        const is_active = passed.is_active !== undefined ? passed.is_active : (existing.is_active ?? false);
        const delay_value = passed.delay_value !== undefined ? passed.delay_value : (existing.delay_value ?? 24);
        const delay_unit = passed.delay_unit !== undefined ? passed.delay_unit : (existing.delay_unit ?? 'hours');
        const message = passed.message !== undefined ? passed.message : (existing.message ?? 'Hey, just following up on your inquiry from yesterday. Are you still looking for help with this? Let me know!');
        const lead_source = passed.lead_source !== undefined ? passed.lead_source : (existing.lead_source ?? 'excel');
        const whatsapp_enabled = passed.whatsapp_enabled !== undefined ? passed.whatsapp_enabled : (existing.whatsapp_enabled ?? true);
        const email_enabled = passed.email_enabled !== undefined ? passed.email_enabled : (existing.email_enabled ?? true);

        const reminder_active = passed.reminder_active !== undefined ? passed.reminder_active : (existing.reminder_active ?? false);
        const reminder_delay_value = passed.reminder_delay_value !== undefined ? passed.reminder_delay_value : (existing.reminder_delay_value ?? 48);
        const reminder_delay_unit = passed.reminder_delay_unit !== undefined ? passed.reminder_delay_unit : (existing.reminder_delay_unit ?? 'hours');
        const reminder_message = passed.reminder_message !== undefined ? passed.reminder_message : (existing.reminder_message ?? 'Hi again! Just a friendly reminder about your inquiry. We haven\'t heard back and want to make sure you got our last message.');
        const followup_sequence = passed.followup_sequence || existing.followup_sequence || [];

        await pool.query(
            `INSERT INTO lead_followup_settings 
                (user_id, is_active, delay_value, delay_unit, message, 
                 reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source, whatsapp_enabled, email_enabled, followup_sequence, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
             ON CONFLICT (user_id) DO UPDATE SET 
                is_active = EXCLUDED.is_active,
                delay_value = EXCLUDED.delay_value,
                delay_unit = EXCLUDED.delay_unit,
                message = EXCLUDED.message,
                reminder_active = EXCLUDED.reminder_active,
                reminder_delay_value = EXCLUDED.reminder_delay_value,
                reminder_delay_unit = EXCLUDED.reminder_delay_unit,
                reminder_message = EXCLUDED.reminder_message,
                lead_source = EXCLUDED.lead_source,
                whatsapp_enabled = EXCLUDED.whatsapp_enabled,
                email_enabled = EXCLUDED.email_enabled,
                followup_sequence = EXCLUDED.followup_sequence,
                updated_at = NOW()`,
            [req.user.id, is_active, delay_value, delay_unit, message,
                reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source,
                whatsapp_enabled, email_enabled, JSON.stringify(followup_sequence)]
        );

        return res.status(200).json({
            success: true,
            message: 'Lead follow-up settings saved successfully!',
            config: {
                is_active, delay_value, delay_unit, message,
                reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source, followup_sequence
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
            // Fast delete: parallelize if multiple deletions needed
            const queries = [];
            
            const current = await pool.query('SELECT lead_capture_active FROM review_funnel_settings WHERE user_id = $1', [userId]);
            const isLeadCaptureActive = current.rows.length > 0 ? current.rows[0].lead_capture_active : false;

            if (isLeadCaptureActive) {
                // Reset review funnel to setup state while keeping lead capture
                queries.push(pool.query(
                    `UPDATE review_funnel_settings SET 
                        is_active = false, 
                        google_review_url = '', 
                        notification_email = '', 
                        auto_response_message = '',
                        filtering_questions = '[]',
                        updated_at = NOW() 
                     WHERE user_id = $1`,
                    [userId]
                ));
            } else {
                // Both are inactive, delete entire record to reset to setup state
                queries.push(pool.query('DELETE FROM review_funnel_settings WHERE user_id = $1', [userId]));
            }

            if (deleteRelatedData) {
                queries.push(pool.query('DELETE FROM feedback WHERE user_id = $1', [userId]));
            }
            
            await Promise.all(queries);
        } 
        else if (recipe === 'leadCapture') {
            const queries = [];
            const current = await pool.query('SELECT is_active FROM review_funnel_settings WHERE user_id = $1', [userId]);
            const isReviewFunnelActive = current.rows.length > 0 ? current.rows[0].is_active : false;

            if (isReviewFunnelActive) {
                // Reset lead capture to setup state while keeping review funnel
                queries.push(pool.query(
                    `UPDATE review_funnel_settings SET 
                        lead_capture_active = false,
                        notification_email = '',
                        auto_response_message = '',
                        filtering_questions = '[]',
                        whatsapp_number_fallback = '',
                        updated_at = NOW() 
                     WHERE user_id = $1`,
                    [userId]
                ));
            } else {
                // Both are inactive, delete entire record to reset to setup state
                queries.push(pool.query('DELETE FROM review_funnel_settings WHERE user_id = $1', [userId]));
            }

            if (deleteRelatedData) {
                queries.push(pool.query("DELETE FROM leads WHERE user_id = $1 AND source ILIKE '%Capture%'", [userId]));
            }
            
            await Promise.all(queries);
        } 
        else if (recipe === 'leadFollowUp') {
            // Delete entire record to reset to setup state
            const queries = [pool.query('DELETE FROM lead_followup_settings WHERE user_id = $1', [userId])];
            
            if (deleteRelatedData) {
                queries.push(pool.query('DELETE FROM leads WHERE user_id = $1', [userId]));
            }
            
            await Promise.all(queries);
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
