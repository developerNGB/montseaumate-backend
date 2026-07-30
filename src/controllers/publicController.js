import { loadProjectEnv } from '../utils/loadEnv.js';
import pool from '../db/pool.js';
import { normalizeLeadGroup } from '../utils/leadGroups.js';
import { frontendBaseUrl } from '../utils/publicUrls.js';
import { injectPlaceholders, createEmailTemplate } from '../utils/templateUtils.js';
import * as whatsappService from '../services/whatsappService.js';
import { sendDynamicEmail } from '../services/emailService.js';
import { computeLeadScore } from '../utils/leadScoring.js';
import { notifyOwnerHotLead } from '../services/ownerNotifyService.js';
import { sendAdminNotification, sendGmailEmail } from '../services/adminMailService.js';

// Load env vars for this controller
loadProjectEnv();

const sendInternalEmail = async (userId, to, subject, message) => {
    if (!to) return 'none';
    try {
        const result = await sendDynamicEmail(userId, {
            to,
            subject,
            text: message,
            html: createEmailTemplate(message, 'there', subject),
        });
        return result.provider || 'email';
    } catch (err) {
        console.error('[PublicAutomation][Email] failed:', err.message);
        return 'none';
    }
};

const sendInternalWhatsApp = async (userId, phone, message) => {
    try {
        const { resolveOwnerWhatsAppPhone } = await import('../services/ownerNotifyService.js');
        const targetPhone =
            String(phone || '')
                .trim()
                .replace(/\D/g, '') || (await resolveOwnerWhatsAppPhone(userId));
        if (!targetPhone) return 'none';

        const waInt = await pool.query(
            `SELECT access_token FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
            [userId]
        );
        if (waInt.rows[0]?.access_token !== 'whatsapp_native_session') return 'none';
        if (whatsappService.getSessionStatus(userId)?.status !== 'connected') return 'none';
        await whatsappService.sendWhatsAppMessage(userId, targetPhone, message);
        return 'whatsapp';
    } catch (err) {
        console.error('[PublicAutomation][WhatsApp] failed:', err.message);
        return 'none';
    }
};

const notifyOwnerInternally = async (config, subject, message) => {
    const tasks = [];
    if (config.email_enabled !== false) {
        tasks.push(sendInternalEmail(config.user_id, config.notification_email || config.owner_email, subject, message));
    }
    if (config.whatsapp_enabled !== false) {
        tasks.push(sendInternalWhatsApp(config.user_id, config.whatsapp_number_fallback, message));
    }
    await Promise.allSettled(tasks);
};

/**
 * GET /api/support/contact/status — public readiness (no secrets exposed)
 */
export const getContactFormStatus = async (_req, res) => {
    try {
        let commitHash = 'unknown';
        try {
            const { execSync } = await import('child_process');
            commitHash = execSync('git rev-parse HEAD').toString().trim();
        } catch (err) {}

                const hasClientId = Boolean(process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID);
        const hasClientSecret = Boolean(process.env.GOOGLE_CLIENT_SECRET);
        const hasRefreshToken = Boolean(process.env.GOOGLE_REFRESH_TOKEN || process.env.CONTACT_FORM_GOOGLE_REFRESH_TOKEN);

        return res.json({
            success: true,
            transport: 'gmail_api_https',
            diagnostics: {
                hasClientId,
                hasClientSecret,
                hasRefreshToken,
                GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? 'SET' : (process.env.VITE_GOOGLE_CLIENT_ID ? 'SET (VITE)' : 'MISSING'),
                GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'MISSING',
                GOOGLE_REFRESH_TOKEN: (process.env.GOOGLE_REFRESH_TOKEN || process.env.CONTACT_FORM_GOOGLE_REFRESH_TOKEN) ? 'SET' : 'MISSING',
            },
            version: commitHash,
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};


/**
 * POST /api/support/contact
 * Saves submission into DB + sends email via direct Gmail REST API over HTTPS (gmail.googleapis.com).
 * Returns 200 OK so contact messages are never lost and visitors always get a success confirmation.
 */
export const submitContactForm = async (req, res) => {
    try {
        const { name, email, message } = req.body;

        const trimmedName    = (name    || '').trim();
        const trimmedEmail   = (email   || '').trim();
        const trimmedMessage = (message || '').trim();

        if (!trimmedName || !trimmedEmail || !trimmedMessage) {
            return res.status(400).json({ success: false, message: 'Please provide name, email and message.' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmedEmail)) {
            return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
        }

        const isSource = req.body.source === 'billing';
        const sourceLabel = isSource ? 'Billing Inquiry (Custom Sales)' : 'Landing Page Contact Form';

        // 1. Resolve Target User and Save to Database (leads table)
        let targetUserId = null;
        const recipientEmail = (
            process.env.CONTACT_FORM_TO?.trim() ||
            process.env.EMAIL_USER?.trim() ||
            process.env.SUPPORT_EMAIL?.trim() ||
            'equipoexpertoia@gmail.com'
        ).trim();

        try {
            const adminRes = await pool.query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [recipientEmail]);
            targetUserId = adminRes.rows[0]?.id;

            if (!targetUserId) {
                const ownerRes = await pool.query(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`);
                targetUserId = ownerRes.rows[0]?.id;
            }

            if (targetUserId) {
                await pool.query(
                    `INSERT INTO leads (user_id, full_name, email, phone, message, source, lead_status)
                     VALUES ($1, $2, $3, $4, $5, $6, 'New')
                     ON CONFLICT DO NOTHING`,
                    [targetUserId, trimmedName, trimmedEmail, '', trimmedMessage, sourceLabel]
                );
                console.log(`[submitContactForm] ✅ Saved message into DB for user ${targetUserId}`);
            }
        } catch (dbErr) {
            console.error('[submitContactForm] DB save notice:', dbErr.message);
        }

        // 2. Construct email payloads
        const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f9f9f9;">
  <div style="background:#fff;border-radius:8px;padding:30px;border:1px solid #e0e0e0;">
    <h2 style="color:#1a1a2e;margin-top:0;">📬 New Contact Message</h2>
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:8px 0;font-weight:bold;color:#555;width:120px;">Source:</td><td style="padding:8px 0;color:#333;">${sourceLabel}</td></tr>
      <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Name:</td><td style="padding:8px 0;color:#333;">${trimmedName}</td></tr>
      <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Email:</td><td style="padding:8px 0;"><a href="mailto:${trimmedEmail}" style="color:#0066cc;">${trimmedEmail}</a></td></tr>
    </table>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
    <h3 style="color:#555;margin-bottom:10px;">Message:</h3>
    <div style="background:#f5f5f5;padding:15px;border-radius:6px;color:#333;line-height:1.6;white-space:pre-wrap;">${trimmedMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
    <p style="color:#888;font-size:12px;margin:0;">Reply directly to <a href="mailto:${trimmedEmail}">${trimmedEmail}</a> to respond to this message.</p>
  </div>
</body>
</html>`;

        const mailData = {
            to: recipientEmail,
            replyTo: trimmedEmail,
            subject: `[Contact Form] New message from ${trimmedName}`,
            text: `Source: ${sourceLabel}\nName: ${trimmedName}\nEmail: ${trimmedEmail}\n\nMessage:\n${trimmedMessage}`,
            html: htmlBody,
        };

        // 3. Attempt sending email to admin inbox using the dedicated adminMailService (uses .env SMTP only)
        try {
            const result = await sendAdminNotification({
                subject: `[Contact Form] New message from ${trimmedName}`,
                text: `Source: ${sourceLabel}\nName: ${trimmedName}\nEmail: ${trimmedEmail}\n\nMessage:\n${trimmedMessage}`,
                html: htmlBody,
                replyTo: trimmedEmail
            });

            console.log('[submitContactForm] Admin notification succeeded:', result);

            // Send auto-response thank-you email to the visitor
            try {
                const autoResponseHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:#fff;border-radius:8px;padding:30px;border:1px solid #e0e0e0;">
    <h2 style="color:#1a1a2e;margin-top:0;">Hi ${trimmedName},</h2>
    <p>Thank you for reaching out to <strong>Equipo Experto</strong>!</p>
    <p>We have successfully received your contact message. Our team is reviewing it and we will get back to you as soon as possible.</p>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
    <p style="font-size:12px;color:#888;">This is an automated confirmation of your message. Please do not reply directly to this email.</p>
  </div>
</body>
</html>`;

                await sendGmailEmail({
                    to: trimmedEmail,
                    subject: 'Thank you for contacting Equipo Experto',
                    text: `Hi ${trimmedName},\n\nThank you for reaching out to Equipo Experto! We have received your message and will get back to you as soon as possible.`,
                    html: autoResponseHtml
                });
                console.log(`[submitContactForm] ✅ Auto-response sent to visitor: ${trimmedEmail}`);
            } catch (autoErr) {
                console.warn('[submitContactForm] Failed to send auto-response email to visitor:', autoErr.message);
            }

            try {
                await pool.query(
                    `INSERT INTO activity_logs (id, user_id, automation_name, trigger_type, status, detail, metadata, created_at)
                     VALUES (gen_random_uuid(), $1, 'Admin Notification', 'Contact Form Submit', 'Success', $2, $3, NOW())`,
                    [
                        targetUserId,
                        `Email sent successfully via ${result.provider || 'unknown'}`,
                        JSON.stringify(result)
                    ]
                );
                console.log('[submitContactForm] ✅ Saved success activity log to DB');
            } catch (logErr) {
                console.error('[submitContactForm] Failed to log success activity to DB:', logErr.message);
            }

            return res.status(200).json({
                success: true,
                message: 'Your message has been received! Our team will get back to you shortly.',
            });

        } catch (err) {
            console.error('[submitContactForm] Admin notification failed:', err.message);
            try {
                await pool.query(
                    `INSERT INTO error_events (id, level, message, stack, context, user_id, route, method, created_at)
                     VALUES (gen_random_uuid(), 'error', $1, $2, $3, $4, '/api/support/contact', 'POST', NOW())`,
                    [
                        `Admin notification failed: ${err.message}`,
                        err.stack || '',
                        JSON.stringify({ recipient: recipientEmail, subject: `[Contact Form] New message from ${trimmedName}` }),
                        targetUserId
                    ]
                );
                console.log('[submitContactForm] ✅ Saved error event to DB');
            } catch (logErr) {
                console.error('[submitContactForm] Failed to log error event to DB:', logErr.message);
            }

            return res.status(500).json({
                success: false,
                message: `Failed to send email: ${err.message}`,
            });
        }

    } catch (err) {
        console.error('[submitContactForm] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'An internal error occurred. Please try again later.',
        });
    }
};


// REMOVED ensureProductionUrl helper to allow direct .env control accurately as requested by user.

/**
 * GET /api/r/:automation_id
 * Just fetches basic styling info or ensures it exists
 */
export const getPublicReviewConfig = async (req, res) => {
    try {
        const { automation_id } = req.params;

        const result = await pool.query(
            `SELECT r.user_id, COALESCE(u.company_name, u.name) as business_name, r.filtering_questions, r.whatsapp_number_fallback
             FROM review_funnel_settings r
             JOIN users u ON u.id = r.user_id 
             WHERE r.automation_id = $1`,
            [automation_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Automation not found.' });
        }

        const config = result.rows[0];

        // Track page views and QR scans in activity_logs
        const source = req.query.source || '';
        const originalUrl = req.originalUrl || '';
        
        let triggerType = 'Form View';
        let automationName = 'Review Funnel';
        let detail = 'Review form viewed';
        
        if (originalUrl.includes('/api/l/')) {
            automationName = 'Lead Capture Form';
            detail = 'Lead capture form viewed';
            if (source === 'qr') {
                triggerType = 'QR Scan';
                detail = 'Lead capture form viewed via QR';
            }
        } else {
            if (source === 'qr') {
                triggerType = 'QR Scan';
                detail = 'QR Code scanned';
            } else if (source === 'list') {
                triggerType = 'List Link Click';
                detail = 'Review link clicked from email/list';
            }
        }

        pool.query(
            `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                config.user_id,
                automationName,
                triggerType,
                'Success',
                detail,
                JSON.stringify({ source, url: originalUrl, date: new Date().toISOString() })
            ]
        ).catch(err => console.error('[getPublicReviewConfig] Log view failed:', err.message));

        return res.status(200).json({ success: true, data: config });

    } catch (err) {
        console.error('[getPublicReviewConfig] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * POST /api/r/:automation_id/submit
 */
export const submitReview = async (req, res) => {
    try {
        const { automation_id } = req.params;
        const { rating, feedback, filtering_responses, ui_language, source } = req.body;
        const reviewLang = String(ui_language || '').toLowerCase().startsWith('es') ? 'es' : 'en';

        console.log(`[submitReview] Incoming review for ${automation_id}:`, { rating, feedback });

        const result = await pool.query(
            `SELECT r.*, COALESCE(u.company_name, u.name) as business_name, u.email as owner_email
             FROM review_funnel_settings r
             JOIN users u ON u.id = r.user_id 
             WHERE r.automation_id = $1`,
            [automation_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Automation not found.' });
        }

        const config = result.rows[0];

        if (!config.is_active) {
            return res.status(403).json({ success: false, message: 'This automation is currently disabled by the owner.' });
        }

        // 5. Backend Stores the Feedback instantly
        let logStatus = rating > 3 ? 'Success' : 'Attention';
        let logDetail = `Rating: ${rating} stars`;

        await pool.query(
            `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                config.user_id,
                'Review Funnel',
                'Customer Review',
                logStatus,
                logDetail,
                JSON.stringify({
                    rating,
                    feedback: feedback || 'No written feedback',
                    filtering_responses: filtering_responses || {},
                    source: source || null,
                    date: new Date().toISOString()
                })
            ]
        );

        if (rating > 3) {
            return res.status(200).json({
                success: true,
                action: 'redirect',
                url: config.google_review_url,
                message: 'Thank you! Would you mind sharing this on Google too?'
            });
        }

        setImmediate(() => {
            notifyOwnerInternally(
                config,
                `New ${rating}-star feedback`,
                `New feedback for ${config.business_name}\n\nRating: ${rating}/5\nFeedback: ${feedback || 'No written feedback'}`
            ).catch(err => console.error('[submitReview] owner notification failed:', err.message));
        });

        return res.status(200).json({
            success: true,
            action: 'message',
            message:
                reviewLang === 'es'
                    ? 'Gracias por contarnos cómo te fue. Lamentamos que no haya sido mejor: nos gustaría entender qué falló — el equipo ya está al tanto y hará seguimiento para solucionarlo.'
                    : "Thanks for being honest with us. We're sorry this wasn't a better experience — we'd like to understand what went wrong. The team has been notified and will follow up to make it right.",
        });

    } catch (err) {
        console.error('[submitReview] CRASH:', err);
        return res.status(500).json({ success: false, message: 'Server error', error: err.message });
    }
};

/**
 * POST /api/f/:automation_id/submit
 * Advanced Survey (3 Star Ratings)
 */
export const submitFeedback = async (req, res) => {
    try {
        const { automation_id } = req.params;
        const { 
            rating_service, 
            rating_product, 
            rating_overall, 
            comment, 
            contact_requested,
            customer_name,
            customer_email,
            customer_phone,
            filtering_responses,
            ui_language,
            source,
        } = req.body;

        const lang = String(ui_language || '')
            .toLowerCase()
            .startsWith('es')
            ? 'es'
            : 'en';

        console.log(`[submitFeedback] Incoming feedback for ${automation_id}:`, { rating_overall, customer_name, contact_requested });

        const result = await pool.query(
            `SELECT r.*, COALESCE(u.company_name, u.name) as business_name, u.email as owner_email
             FROM review_funnel_settings r
             JOIN users u ON u.id = r.user_id 
             WHERE r.automation_id = $1`,
            [automation_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Automation not found.' });
        }

        const config = result.rows[0];

        // 1. Save to Feedback Table
        await pool.query(
            `INSERT INTO feedback (user_id, automation_id, rating_service, rating_product, rating_overall, comment, contact_requested, customer_name, customer_email, customer_phone)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                config.user_id,
                automation_id,
                rating_service || 5,
                rating_product || 5,
                rating_overall || 5,
                comment || '',
                !!contact_requested,
                customer_name || null,
                customer_email || null,
                customer_phone || null
            ]
        );

        // 2. If contact requested, also save as a Lead
        if (contact_requested && (customer_email || customer_phone)) {
            const feedbackGroup = normalizeLeadGroup(req.body.lead_group, 'Reviews');
            const finalSource = source === 'qr' ? 'QR Survey' : (source === 'list' ? 'Excel Upload' : `Feedback Funnel: ${automation_id}`);
            await pool.query(
                `INSERT INTO leads (user_id, full_name, email, phone, message, source, lead_group, consent_given, marketing_consent)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    config.user_id,
                    customer_name || 'Anonymous Feedback',
                    customer_email || 'no-email@feedback.com',
                    customer_phone || '',
                    `Feedback Comment: ${comment}`,
                    finalSource,
                    feedbackGroup,
                    true,
                    !!contact_requested
                ]
            );
        }

        // 3. Log Activity
        await pool.query(
            `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                config.user_id,
                'Survey Funnel',
                'Feedback Received',
                rating_overall > 3 ? 'Success' : 'Attention',
                `Rating: ${rating_overall} stars from ${customer_name || 'Guest'}`,
                JSON.stringify({ 
                    rating_service, 
                    rating_product, 
                    rating_overall, 
                    comment, 
                    contact_requested,
                    customer_name,
                    customer_email,
                    customer_phone,
                    filtering_responses: filtering_responses || {},
                    source: source || null,
                })
            ]
        );

        const baseUrl = frontendBaseUrl() || '';
        if (!baseUrl) console.error('[submitFeedback] FRONTEND_URL is not set');
        const dash = baseUrl ? `${baseUrl}/dashboard/feedback` : '(set FRONTEND_URL on server)';
        const ownerMsg = `New feedback for ${config.business_name}\n\nCustomer: ${customer_name || 'Guest'}\nEmail: ${customer_email || 'N/A'}\nPhone: ${customer_phone || 'N/A'}\nRating: ${rating_overall}/5\nComment: ${comment || 'No comment'}\nDashboard: ${dash}`;
        setImmediate(() => {
            notifyOwnerInternally(config, `New ${rating_overall}-star feedback`, ownerMsg)
                .catch(err => console.error('[submitFeedback] owner notification failed:', err.message));
        });

        /** After survey submit only — never reuse auto_response_message (invite copy + funnel link). */
        const isPromoter = Number(rating_overall) >= 4;
        const POST_SURVEY_THANK_YOU =
            lang === 'es'
                ? '¡Hola {name}! Gracias por tu opinión — la hemos recibido y valoramos mucho tu tiempo.\n\n' +
                  'Si necesitas algo más de nosotros, responde aquí y encantados de ayudarte.'
                : 'Hi {name}! Thank you for your feedback — we have received it and truly appreciate you taking the time.\n\n' +
                  'If you need anything else from us, just reply here and we will be glad to help.';
        const POST_SURVEY_FOLLOW_UP_LOW =
            lang === 'es'
                ? '¡Hola {name}! Lamentamos que tu experiencia no haya estado a la altura — nos importa entender qué falló para poder mejorar.\n\n' +
                  'El equipo ya está al tanto. ¿Podrías responder aquí con los detalles que quieras compartir? Nos ayuda mucho a solucionarlo.'
                : 'Hi {name}! We are sorry your experience fell short — we genuinely want to know what went wrong so we can fix it.\n\n' +
                  'The team has been notified. Could you reply here with anything we should know? Your details help us make this right.';
        const customerOutreachTemplate = isPromoter ? POST_SURVEY_THANK_YOU : POST_SURVEY_FOLLOW_UP_LOW;
        const customerEmailSubject = isPromoter
            ? lang === 'es'
                ? 'Gracias por tu opinión'
                : 'Thanks for your feedback'
            : lang === 'es'
              ? 'Queremos solucionar esto'
              : "We'd like to make this right";

        const thankYouSubstitutions = {
            name: customer_name || (lang === 'es' ? 'cliente' : 'there'),
            link: '',
            googleReviewUrl: '',
            reviewUrl: '',
            publicUrl: '',
        };

        if (customer_phone && config.whatsapp_enabled !== false) {
            const finalMsg = injectPlaceholders(customerOutreachTemplate, thankYouSubstitutions);
            setImmediate(() => {
                sendInternalWhatsApp(config.user_id, customer_phone, finalMsg)
                    .catch(err => console.error('[submitFeedback] customer WhatsApp failed:', err.message));
            });
        }

        if (customer_email && config.email_enabled !== false) {
            const emailMsg = injectPlaceholders(customerOutreachTemplate, thankYouSubstitutions);
            setImmediate(() => {
                sendInternalEmail(config.user_id, customer_email, customerEmailSubject, emailMsg)
                    .catch(err => console.error('[submitFeedback] customer email failed:', err.message));
            });
        }

        console.log(`\n==================== [FEEDBACK SUBMITTED] ====================`);
        console.log(`👤 Customer: ${customer_name || 'Guest'}`);
        console.log(`⭐ Rating: ${rating_overall}/5`);
        console.log(`📱 Contact Requested: ${contact_requested ? 'YES' : 'NO'}`);
        console.log(`📱 Phone: ${customer_phone || 'None'}`);
        console.log(`===============================================================\n`);

        const finalResponse = {
            success: true,
        };

        if (rating_overall >= 4) {
            finalResponse.action = 'suggest_google';
            finalResponse.message =
                lang === 'es'
                    ? '¡Gracias! Tu opinión es muy valiosa. ¿Te gustaría compartir tu experiencia en Google también?'
                    : 'Thank you! Your feedback is invaluable. Would you mind sharing your experience on Google as well?';
            finalResponse.google_url = config.google_review_url;
        } else {
            finalResponse.action = 'message';
            finalResponse.message =
                lang === 'es'
                    ? 'Lamentamos que no haya sido una buena experiencia. Nos gustaría entender qué falló: si aún no lo contaste, añade un poco más arriba o te contactaremos desde aquí. Gracias por avisarnos — el equipo ya está al tanto.'
                    : "We're sorry this wasn't what you hoped for. We'd really like to understand what went wrong — if you haven't already, add a bit more detail above and we'll follow up from here. Thanks for letting us know; the team has been notified.";
        }

        return res.status(200).json(finalResponse);

    } catch (err) {
        console.error('[submitFeedback] CRITICAL ERR:', err);
        return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
};

/**
 * POST /api/l/:automation_id/lead
 */
export const submitLead = async (req, res) => {
    try {
        const { automation_id } = req.params;
        const { full_name, email, phone, message, filtering_responses, consent_given, marketing_consent, lead_group, source } = req.body;
        const captureGroup = normalizeLeadGroup(lead_group, 'Captured');
        console.log(`[submitLead] Incoming lead for ${automation_id}:`, { full_name, email, marketing_consent });

        if (!full_name || !email || !phone) {
            return res.status(400).json({ success: false, message: 'Please provide full name, email, and phone number.' });
        }

        if (!consent_given) {
            return res.status(400).json({ success: false, message: 'You must agree to be contacted to submit this form.' });
        }

        const result = await pool.query(
            `SELECT rfs.user_id, rfs.lead_capture_active, rfs.is_active, rfs.auto_response_message,
                    rfs.google_review_url,
                    rfs.notification_email, rfs.whatsapp_number_fallback, rfs.whatsapp_enabled, rfs.email_enabled,
                    u.email as owner_email, u.company_name
             FROM review_funnel_settings rfs
             JOIN users u ON rfs.user_id = u.id
             WHERE rfs.automation_id = $1`,
            [automation_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }

        if (!result.rows[0].lead_capture_active && !result.rows[0].is_active) {
            return res.status(403).json({ success: false, message: 'This automation is currently disabled by the owner.' });
        }

        const user_id = result.rows[0].user_id;
        const owner_email = result.rows[0].owner_email;
        const current_date = new Date().toISOString();

        const finalSource = source === 'qr' ? 'QR Survey' : (source === 'list' ? 'Excel Upload' : 'Public Link');

        // 1. Save Lead to DB
        const leadInsert = await pool.query(
            `INSERT INTO leads (user_id, full_name, email, phone, message, filtering_responses, source, lead_group, consent_given, marketing_consent, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [user_id, full_name, email, phone, message || '', JSON.stringify(filtering_responses || {}), finalSource, captureGroup, !!consent_given, !!marketing_consent, current_date]
        );
        const lead_id = leadInsert.rows[0].id;

        // 1b. Score the lead (used for the dashboard score bar + hot-lead alerts)
        const { score: leadScore, tier: leadScoreTier, matchedKeywords } = computeLeadScore({
            email, phone, consent_given, marketing_consent, lead_status: 'New', message, filtering_responses
        });
        await pool.query(
            `UPDATE leads SET lead_score = $1, lead_score_tier = $2 WHERE id = $3`,
            [leadScore, leadScoreTier, lead_id]
        );

        // 2. Log Activity
        await pool.query(
            `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                user_id,
                'Lead Capture Form',
                'Lead Subscribed',
                'Success',
                `Captured contact: ${full_name}`,
                JSON.stringify({ full_name, email, phone, message: message || '', filtering_responses, consent_given, marketing_consent, source: source || null, date: current_date })
            ]
        );

        // Respond immediately — never block the public form on notification delivery.
        res.status(200).json({
            success: true,
            status: 'success',
            message: 'Lead Submitted',
            data: { user_id, owner_email, date: current_date }
        });

        // === BACKGROUND: WhatsApp + email (fire-and-forget, never blocks response) ===
        setImmediate(async () => {
            try {
                console.log(`\n==================== [LEAD BG DISPATCH] ====================`);
                console.log(`👤 Name:  ${full_name}`);
                console.log(`📧 Email: ${email}`);
                console.log(`📱 Phone: ${phone}`);

                const intRes = await pool.query(
                    `SELECT provider, access_token, account_id FROM integrations WHERE user_id = $1`,
                    [user_id]
                );
                const integrations = intRes.rows.reduce((acc, curr) => {
                    acc[curr.provider] = { 
                        access_token: curr.access_token, 
                        refresh_token: curr.refresh_token,
                        account_id: curr.account_id 
                    };
                    return acc;
                }, {});

                const whatsappAuth = integrations['whatsapp'] || {};
                const baseUrl = frontendBaseUrl() || '';
                if (!baseUrl) console.error('[submitLeadCapture] FRONTEND_URL is not set');
                let questionsStr = '';
                if (filtering_responses && typeof filtering_responses === 'object') {
                    questionsStr = '\n\nResponses:\n' + Object.entries(filtering_responses)
                        .map(([q, a]) => `- ${q}: ${a}`).join('\n');
                }
                const dashLeads = baseUrl ? `${baseUrl}/dashboard/leads` : '(set FRONTEND_URL)';
                const ownerMsg = `New lead\n\nName: ${full_name}\nEmail: ${email}\nPhone: ${phone}\nMessage: ${message || 'No message'}${questionsStr}\n\nDashboard: ${dashLeads}`;
                const defaultMsg = `Hello ${full_name || 'there'}, thank you for filling out our form! We've received your inquiry and will be in touch soon.`;
                const leadLink = baseUrl ? `${baseUrl}/l/${automation_id}` : '';
                const reviewLink = baseUrl ? `${baseUrl}/r/${automation_id}` : '';
                const finalCustomerMsg = injectPlaceholders(result.rows[0].auto_response_message || defaultMsg, {
                    name: full_name || 'there',
                    link: leadLink,
                    reviewUrl: reviewLink,
                    googleReviewUrl: result.rows[0].google_review_url,
                    number: whatsappAuth.account_id || '',
                    company: result.rows[0].company_name || 'our company'
                });

                if (result.rows[0].email_enabled !== false) {
                    await sendInternalEmail(user_id, result.rows[0].notification_email || owner_email, 'New lead captured', ownerMsg);
                    await sendInternalEmail(user_id, email, 'Thanks for contacting us', finalCustomerMsg);
                }

                // 🔥 HOT LEAD INSTANT ALERT — extra ping when this lead scores "high"
                if (leadScoreTier === 'high') {
                    try {
                        await pool.query(`UPDATE leads SET hot_alert_sent_at = NOW() WHERE id = $1`, [lead_id]);
                        await notifyOwnerHotLead(user_id, {
                            fullName: full_name, email, phone, message,
                            score: leadScore, matchedKeywords, leadId: lead_id
                        });
                        console.log(`[HotLead] 🔥 Alert sent for lead ${lead_id} (score ${leadScore})`);
                    } catch (hotErr) {
                        console.error(`[HotLead] ❌ Alert failed:`, hotErr.message);
                    }
                }

                console.log(`[WA-Check] token="${whatsappAuth.access_token}" | account="${whatsappAuth.account_id}"`);

                if (result.rows[0].whatsapp_enabled !== false && whatsappAuth.access_token === 'whatsapp_native_session') {
                    // A. OWNER — full data dump
                    const ownerPhone = whatsappAuth.account_id;
                    if (ownerPhone) {
                        console.log(`[WA-Owner] → ${ownerPhone}`);
                        whatsappService.sendWhatsAppMessage(user_id, ownerPhone, ownerMsg)
                            .then(() => console.log(`[WA-Owner] ✅ Sent`))
                            .catch(e => console.error(`[WA-Owner] ❌ ${e.message}`));
                    } else {
                        console.log(`[WA-Owner] ⚠️ No account_id in DB — owner not notified`);
                    }

                    let autoResponseSent = false;

                    // C. INSTANT: Fire follow-up sequence step 0 immediately (bypass cron delay)
                    if (phone) {
                        try {
                            const settingsRes = await pool.query(
                                `SELECT followup_sequence, is_active FROM lead_followup_settings WHERE user_id = $1`,
                                [user_id]
                            );
                            const settings = settingsRes.rows[0];
                            const sequence = Array.isArray(settings?.followup_sequence)
                                ? settings.followup_sequence
                                : (typeof settings?.followup_sequence === 'string' ? JSON.parse(settings.followup_sequence) : []);

                            if (settings?.is_active && sequence.length > 0) {
                                // Atomically claim step 0 to prevent race with cron
                                const claim = await pool.query(
                                    `UPDATE leads SET followup_status = 'processing', updated_at = NOW()
                                     WHERE id = $1 AND (followup_status IS NULL OR followup_status != 'processing')
                                     RETURNING id`,
                                    [lead_id]
                                );

                                if (claim.rowCount > 0) {
                                    const sessionStatus = whatsappService.getSessionStatus(user_id);
                                    if (sessionStatus.status === 'connected') {
                                        const step0 = sequence[0];
                                        const step0Msg = injectPlaceholders(step0.message || '', {
                                            name: full_name,
                                            link: `${baseUrl}/r/${automation_id}`,
                                            reviewUrl: `${baseUrl}/r/${automation_id}`,
                                            googleReviewUrl: result.rows[0].google_review_url,
                                            number: whatsappAuth.account_id || '',
                                            company: result.rows[0].company_name || 'our company'
                                        });
                                        await whatsappService.sendWhatsAppMessage(user_id, phone, step0Msg);
                                        await pool.query(
                                            `UPDATE leads SET followup_step_index = 1, last_followup_at = NOW(),
                                             lead_status = 'Contacted', followup_status = 'pending', updated_at = NOW()
                                             WHERE id = $1`,
                                            [lead_id]
                                        );
                                        console.log(`[WA-Step0] ✅ First follow-up step sent instantly to ${phone}`);
                                        autoResponseSent = true;
                                    } else {
                                        // Session not ready — release claim so cron handles it
                                        await pool.query(
                                            `UPDATE leads SET followup_status = NULL, updated_at = NOW() WHERE id = $1`,
                                            [lead_id]
                                        );
                                        console.log(`[WA-Step0] ⚠️ Session ${sessionStatus.status} — cron will handle step 0`);
                                    }
                                }
                            }
                        } catch (step0Err) {
                            console.error(`[WA-Step0] ❌ Instant step 0 failed:`, step0Err.message);
                            // Release claim so cron can retry
                            try {
                                await pool.query(
                                    `UPDATE leads SET followup_status = NULL, updated_at = NOW() WHERE id = $1`,
                                    [lead_id]
                                );
                            } catch (_) {}
                        }
                    }

                    // B. CUSTOMER — auto-response (Only sent if we didn't send step 0 follow-up)
                    if (phone && !autoResponseSent) {
                        console.log(`[WA-Customer] → ${phone}`);
                        whatsappService.sendWhatsAppMessage(user_id, phone, finalCustomerMsg)
                            .then(() => console.log(`[WA-Customer] ✅ Sent`))
                            .catch(e => console.error(`[WA-Customer] ❌ ${e.message}`));
                    }
                } else {
                    console.log(`[WA-Native] ⚠️ Not active. Token: "${whatsappAuth.access_token}"`);
                }
                console.log(`============================================================\n`);
            } catch (bgErr) {
                console.error(`[BG-Dispatch] ❌ Error:`, bgErr.message);
            }
        });

    } catch (err) {
        console.error('[submitLead] CRITICAL ERR:', err);
        return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
    }
};
