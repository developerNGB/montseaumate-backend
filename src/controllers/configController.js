import pool from '../db/pool.js';
import { frontendBaseUrl } from '../utils/publicUrls.js';
import crypto from 'crypto';
import qrcode from 'qrcode';
import { countEmployeesAfterPatch, getMaxEmployees, getMaxFollowupSequenceSteps } from '../services/subscriptionPlans.js';

async function loadBillingRow(userId) {
    const u = await pool.query('SELECT plan, trial_ends_at FROM users WHERE id = $1', [userId]);
    return u.rows[0] || { plan: 'free', trial_ends_at: null };
}

function respondEmployeeLimit(res, billing, wouldTotal) {
    const maxEmp = getMaxEmployees(billing.plan, billing.trial_ends_at);
    return res.status(403).json({
        success: false,
        code: 'EMPLOYEE_PLAN_LIMIT',
        message: `Your subscription allows ${maxEmp} active automation(s). Turn one off in Employees or upgrade your plan.`,
        max_employees: maxEmp,
        attempted: wouldTotal,
    });
}
// GET /api/config/review-funnel
export const getReviewFunnelConfig = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT automation_id, google_review_url, notification_email, auto_response_message, filtering_questions, is_active, lead_capture_active, whatsapp_number_fallback, lead_source, capture_source, lead_sources, capture_sources, whatsapp_enabled, email_enabled, COALESCE(review_next_step_done, FALSE) AS review_next_step_done, COALESCE(capture_next_step_done, FALSE) AS capture_next_step_done FROM review_funnel_settings WHERE user_id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(200).json({ success: true, config: null });
        }

        const config = result.rows[0];
        const baseUrl = frontendBaseUrl();
        if (!baseUrl) {
            return res.status(500).json({
                success: false,
                message: 'Server misconfiguration: set FRONTEND_URL for public links and QR codes.',
            });
        }

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
                lead_sources: config.lead_sources ? (typeof config.lead_sources === 'string' ? JSON.parse(config.lead_sources) : config.lead_sources) : [config.lead_source || 'qr'],
                capture_sources: config.capture_sources ? (typeof config.capture_sources === 'string' ? JSON.parse(config.capture_sources) : config.capture_sources) : [config.capture_source || 'qr'],
                whatsapp_enabled: config.whatsapp_enabled ?? true,
                email_enabled: config.email_enabled ?? true,
                review_next_step_done: !!config.review_next_step_done,
                capture_next_step_done: !!config.capture_next_step_done
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

        // Try to fetch google_review_url from integrations if not provided
        let finalGoogleReviewUrl = google_review_url;
        if (!finalGoogleReviewUrl || finalGoogleReviewUrl.trim() === '') {
            const googleIntRes = await pool.query('SELECT account_id FROM integrations WHERE user_id = $1 AND provider = $2', [req.user.id, 'google']);
            if (googleIntRes.rows.length > 0 && googleIntRes.rows[0].account_id.startsWith('http')) {
                finalGoogleReviewUrl = googleIntRes.rows[0].account_id;
            }
        }

        const lfEmpRes = await pool.query(
            'SELECT is_active FROM lead_followup_settings WHERE user_id = $1',
            [req.user.id]
        );
        const lfEmpRow = lfEmpRes.rows[0] || {};
        const projectedEmployees = countEmployeesAfterPatch({
            rf: existingConfig,
            lf: lfEmpRow,
            patch: {
                is_active: finalReviewActive,
                lead_capture_active: finalCaptureActive,
            },
        });
        const billingRow = await loadBillingRow(req.user.id);
        const maxEmployeesAllowed = getMaxEmployees(billingRow.plan, billingRow.trial_ends_at);
        if (projectedEmployees > maxEmployeesAllowed) {
            return respondEmployeeLimit(res, billingRow, projectedEmployees);
        }

        const reviewIntroDone = !!existingConfig.review_next_step_done || !!finalReviewActive;
        const captureIntroDone = !!existingConfig.capture_next_step_done || !!finalCaptureActive;

        await pool.query(
            `INSERT INTO review_funnel_settings 
                (user_id, automation_id, google_review_url, notification_email, auto_response_message, filtering_questions, lead_capture_active, is_active, whatsapp_number_fallback, lead_source, capture_source, whatsapp_enabled, email_enabled, review_next_step_done, capture_next_step_done, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
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
                review_next_step_done = EXCLUDED.review_next_step_done,
                capture_next_step_done = EXCLUDED.capture_next_step_done,
                updated_at = NOW()`,
            [
                req.user.id, automationId, 
                finalGoogleReviewUrl !== undefined ? finalGoogleReviewUrl : existingConfig.google_review_url || '', 
                notification_email !== undefined ? notification_email : existingConfig.notification_email || '', 
                auto_response_message !== undefined ? auto_response_message : existingConfig.auto_response_message || '', 
                JSON.stringify(filtering_questions || existingConfig.filtering_questions || []), 
                finalCaptureActive, 
                finalReviewActive, 
                whatsapp_number_fallback !== undefined ? whatsapp_number_fallback : existingConfig.whatsapp_number_fallback || '', 
                finalLeadSource, finalCaptureSource,
                whatsapp_enabled !== undefined ? whatsapp_enabled : (existingConfig.whatsapp_enabled ?? true),
                email_enabled !== undefined ? email_enabled : (existingConfig.email_enabled ?? true),
                reviewIntroDone,
                captureIntroDone,
            ]
        );

        // Save multi-source arrays (columns added via migration; fails silently if not yet present)
        const leadSourcesArr = req.body.lead_sources || [finalLeadSource];
        const captureSourcesArr = req.body.capture_sources || [finalCaptureSource];
        try {
            await pool.query(
                `UPDATE review_funnel_settings SET lead_sources = $1, capture_sources = $2 WHERE user_id = $3`,
                [JSON.stringify(leadSourcesArr), JSON.stringify(captureSourcesArr), req.user.id]
            );
        } catch (_) { /* column not yet migrated — safe to ignore */ }

        const baseUrl = frontendBaseUrl();
        if (!baseUrl) {
            return res.status(500).json({
                success: false,
                message: 'Server misconfiguration: set FRONTEND_URL for public links and QR codes.',
            });
        }
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
                capture_source: finalCaptureSource,
                lead_sources: leadSourcesArr,
                capture_sources: captureSourcesArr,
                is_active: finalReviewActive,
                lead_capture_active: finalCaptureActive,
                review_next_step_done: reviewIntroDone,
                capture_next_step_done: captureIntroDone,
            }
        });

    } catch (err) {
        console.error('[saveReviewFunnelConfig] CRITICAL ERR:', err.code, err.message, err.detail || '');
        return res.status(500).json({ success: false, message: err.message || 'Internal server error', code: err.code });
    }
};

// GET /api/config/lead-followup
export const getLeadFollowupConfig = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT is_active, delay_value, delay_unit, message, reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source, whatsapp_enabled, email_enabled, followup_sequence, COALESCE(followup_next_step_done, FALSE) AS followup_next_step_done FROM lead_followup_settings WHERE user_id = $1',
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
                followup_sequence: typeof config.followup_sequence === 'string' ? JSON.parse(config.followup_sequence) : (config.followup_sequence || []),
                followup_next_step_done: !!config.followup_next_step_done,
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

        // Fetch existing config first — try full column list, fall back if columns missing
        let existingRes;
        try {
            existingRes = await pool.query(
                'SELECT is_active, delay_value, delay_unit, message, reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source, whatsapp_enabled, email_enabled, followup_sequence, COALESCE(followup_next_step_done, FALSE) AS followup_next_step_done FROM lead_followup_settings WHERE user_id = $1',
                [req.user.id]
            );
        } catch (e) {
            if (e.code !== '42703') throw e;
            existingRes = await pool.query(
                'SELECT is_active, delay_value, delay_unit, message, lead_source FROM lead_followup_settings WHERE user_id = $1',
                [req.user.id]
            );
        }
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
        const rawFollowupSeq =
            passed.followup_sequence !== undefined
                ? passed.followup_sequence
                : (existing.followup_sequence ?? []);
        let followup_sequence =
            typeof rawFollowupSeq === 'string'
                ? (() => {
                      try {
                          return JSON.parse(rawFollowupSeq);
                      } catch {
                          return [];
                      }
                  })()
                : rawFollowupSeq;
        if (!Array.isArray(followup_sequence)) followup_sequence = [];

        const billingLf = await loadBillingRow(req.user.id);
        const maxFollowSteps = getMaxFollowupSequenceSteps(billingLf.plan, billingLf.trial_ends_at);
        if (maxFollowSteps !== null && followup_sequence.length > maxFollowSteps) {
            return res.status(403).json({
                success: false,
                code: 'FOLLOWUP_SEQUENCE_PLAN_LIMIT',
                message: `Your plan allows up to ${maxFollowSteps} follow-up step(s) in this sequence. Remove extra steps or upgrade to use more.`,
                max_steps: maxFollowSteps,
                attempted: followup_sequence.length,
            });
        }

        const rfEmp = await pool.query(
            'SELECT is_active, lead_capture_active FROM review_funnel_settings WHERE user_id = $1',
            [req.user.id]
        );
        const projectedLfEmp = countEmployeesAfterPatch({
            rf: rfEmp.rows[0] || {},
            lf: existing,
            patch: { followup_active: is_active },
        });
        if (projectedLfEmp > getMaxEmployees(billingLf.plan, billingLf.trial_ends_at)) {
            return respondEmployeeLimit(res, billingLf, projectedLfEmp);
        }

        const followIntroDone = !!existing.followup_next_step_done || !!is_active;

        try {
            await pool.query(
                `INSERT INTO lead_followup_settings
                    (user_id, is_active, delay_value, delay_unit, message,
                     reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source, whatsapp_enabled, email_enabled, followup_sequence, followup_next_step_done, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
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
                    followup_next_step_done = EXCLUDED.followup_next_step_done,
                    updated_at = NOW()`,
                [req.user.id, is_active, delay_value, delay_unit, message,
                    reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source,
                    whatsapp_enabled, email_enabled, JSON.stringify(followup_sequence), followIntroDone]
            );
        } catch (e) {
            if (e.code !== '42703') throw e;
            // Columns not yet migrated — save only guaranteed-present core fields (no updated_at)
            await pool.query(
                `INSERT INTO lead_followup_settings (user_id, is_active, delay_value, delay_unit, message, lead_source)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (user_id) DO UPDATE SET
                    is_active = EXCLUDED.is_active,
                    delay_value = EXCLUDED.delay_value,
                    delay_unit = EXCLUDED.delay_unit,
                    message = EXCLUDED.message,
                    lead_source = EXCLUDED.lead_source`,
                [req.user.id, is_active, delay_value, delay_unit, message, lead_source]
            );
        }

        return res.status(200).json({
            success: true,
            message: 'Lead follow-up settings saved successfully!',
            config: {
                is_active, delay_value, delay_unit, message,
                reminder_active, reminder_delay_value, reminder_delay_unit, reminder_message, lead_source, followup_sequence,
                whatsapp_enabled, email_enabled, followup_next_step_done: followIntroDone,
            }
        });

    } catch (err) {
        console.error('[saveLeadFollowupConfig] Error:', err.code, err.message, err.detail || '');
        return res.status(500).json({ success: false, message: `Server error: ${err.message}`, code: err.code });
    }
};

export const toggleRecipe = async (req, res) => {
    try {
        const { recipe, is_active } = req.body;
        const userId = req.user.id;

        if (is_active === true) {
            const [rfRes, lfRes, billingEmp] = await Promise.all([
                pool.query(
                    'SELECT is_active, lead_capture_active FROM review_funnel_settings WHERE user_id = $1',
                    [userId]
                ),
                pool.query('SELECT is_active FROM lead_followup_settings WHERE user_id = $1', [userId]),
                loadBillingRow(userId),
            ]);
            const patch = {};
            if (recipe === 'reviewFunnel') patch.is_active = true;
            else if (recipe === 'leadCapture') patch.lead_capture_active = true;
            else if (recipe === 'leadFollowUp') patch.followup_active = true;
            const projected = countEmployeesAfterPatch({
                rf: rfRes.rows[0] || {},
                lf: lfRes.rows[0] || {},
                patch,
            });
            if (projected > getMaxEmployees(billingEmp.plan, billingEmp.trial_ends_at)) {
                return respondEmployeeLimit(res, billingEmp, projected);
            }
        }

        if (recipe === 'reviewFunnel') {
            await pool.query(
                `INSERT INTO review_funnel_settings (user_id, automation_id, google_review_url, notification_email, is_active, review_next_step_done)
                 VALUES ($1, md5(random()::text), '', '', $2, $2)
                 ON CONFLICT (user_id) DO UPDATE SET 
                    is_active = EXCLUDED.is_active,
                    review_next_step_done = COALESCE(review_funnel_settings.review_next_step_done, FALSE) OR EXCLUDED.is_active`,
                [userId, is_active]
            );
        } else if (recipe === 'leadCapture') {
            await pool.query(
                `INSERT INTO review_funnel_settings (user_id, automation_id, google_review_url, notification_email, lead_capture_active, capture_next_step_done)
                 VALUES ($1, md5(random()::text), '', '', $2, $2)
                 ON CONFLICT (user_id) DO UPDATE SET 
                    lead_capture_active = EXCLUDED.lead_capture_active,
                    capture_next_step_done = COALESCE(review_funnel_settings.capture_next_step_done, FALSE) OR EXCLUDED.lead_capture_active`,
                [userId, is_active]
            );
        } else if (recipe === 'leadFollowUp') {
            await pool.query(
                `INSERT INTO lead_followup_settings (user_id, is_active, followup_next_step_done) 
                 VALUES ($1, $2, $2)
                 ON CONFLICT (user_id) DO UPDATE SET 
                    is_active = EXCLUDED.is_active,
                    followup_next_step_done = COALESCE(lead_followup_settings.followup_next_step_done, FALSE) OR EXCLUDED.is_active`,
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
