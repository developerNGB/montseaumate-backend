import pool from '../db/pool.js';
import nodemailer from 'nodemailer';
import { getValidGoogleToken } from '../utils/googleAuth.js';
import { injectPlaceholders } from '../utils/templateUtils.js';

/**
 * Ensures n8n URLs use the /webhook-test/ path for debugging.
 */
const ensureTestUrl = (url) => {
    if (url && url.includes('n8n.cloud/webhook/')) {
        return url.replace('n8n.cloud/webhook/', 'n8n.cloud/webhook-test/');
    }
    return url;
};
import * as whatsappService from '../services/whatsappService.js';

/**
 * GET /api/r/:automation_id
 * Just fetches basic styling info or ensures it exists
 */
export const getPublicReviewConfig = async (req, res) => {
    try {
        const { automation_id } = req.params;

        const result = await pool.query(
            `SELECT COALESCE(u.company_name, u.name) as business_name, r.filtering_questions
             FROM review_funnel_settings r
             JOIN users u ON u.id = r.user_id 
             WHERE r.automation_id = $1`,
            [automation_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Automation not found.' });
        }

        return res.status(200).json({ success: true, data: result.rows[0] });

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
        const { rating, feedback, filtering_responses, n8nWebhook } = req.body;

        const result = await pool.query(
            `SELECT r.*, COALESCE(u.company_name, u.name) as business_name
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
                    date: new Date().toISOString()
                })
            ]
        );

        // 6. Trigger n8n explicitly and rely on N8N's decision engine
        const finalWebhook = ensureTestUrl(n8nWebhook || "https://dataanalyst.app.n8n.cloud/webhook-test/review-feedback");
        if (finalWebhook) {
            try {
                // Get fresh Google Token if possible
                const freshGoogleToken = await getValidGoogleToken(config.user_id);

                // Fetch current integrations to get WhatsApp token and backup Google tokens
                const integrationsResult = await pool.query(
                    `SELECT provider, access_token, refresh_token FROM integrations WHERE user_id = $1`,
                    [config.user_id]
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

                // Use the fresh token if we got one, otherwise use the stored one
                const currentGoogleAccessToken = freshGoogleToken || googleAuth.access_token;

                const n8nRes = await fetch(finalWebhook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        rating,
                        feedback,
                        business_name: config.business_name,
                        automation_id,
                        google_review_url: config.google_review_url,
                        notification_email: config.notification_email,
                        // Credentials for n8n to act on behalf of user
                        client_id: process.env.GOOGLE_CLIENT_ID,
                        client_secret: process.env.GOOGLE_CLIENT_SECRET,
                        access_token: currentGoogleAccessToken || null,
                        refresh_token: googleAuth.refresh_token || null,
                        whatsapp_access_token: whatsappAuth.access_token || null,
                        whatsapp_refresh_token: whatsappAuth.refresh_token || null,
                    })
                });

                const data = await n8nRes.json();

                if (data.action) {
                    return res.status(200).json({ success: true, ...data });
                }

                const isGenericSuccess = data.success === true || (data['0'] && data['0'].status === 'success');

                if (isGenericSuccess) {
                    // 📝 LOG ACTIVITY: REVIEW SUBMITTED
                    await pool.query(
                        `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, metadata, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                        [
                            config.user_id,
                            'Review Funnel',
                            'Review Submitted',
                            'Success',
                            `Received ${rating}-star review from public page.`,
                            JSON.stringify({ rating, feedback, business_name: config.business_name })
                        ]
                    );

                    if (rating > 3) {
                        return res.status(200).json({
                            success: true,
                            action: 'redirect',
                            url: config.google_review_url
                        });
                    } else {
                        return res.status(200).json({
                            success: true,
                            action: 'message',
                            message: "Thank you so much for your honest feedback. Our owner has been directly notified so we can make this right!"
                        });
                    }
                }

                return res.status(200).json({
                    success: true,
                    action: 'message',
                    message: "Thank you for your feedback! It has been recorded successfully."
                });
            } catch (err) {
                console.error('N8N Webhook failed:', err.message);
                return res.status(200).json({
                    success: true,
                    action: 'message',
                    message: "Thank you for your feedback!"
                });
            }
        } else {
            return res.status(200).json({
                success: true,
                action: 'message',
                message: "Thank you! Feedback received."
            });
        }

    } catch (err) {
        console.error('[submitReview] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
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
            customer_phone
        } = req.body;

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
            await pool.query(
                `INSERT INTO leads (user_id, full_name, email, phone, message, source, consent_given, marketing_consent)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    config.user_id,
                    customer_name || 'Anonymous Feedback',
                    customer_email || 'no-email@feedback.com',
                    customer_phone || '',
                    `Feedback Comment: ${comment}`,
                    `Feedback Funnel: ${automation_id}`,
                    true,
                    false
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
                JSON.stringify({ rating_service, rating_product, rating_overall, comment, contact_requested })
            ]
        );

        // 4. Fetch Integration Tokens (Server-Side Only - Secure)
        let currentGoogleAccessToken = null;
        let googleRefreshToken = null;
        let whatsappAccessToken = null;
        let whatsappRefreshToken = null;

        try {
            // Get fresh Google Token
            currentGoogleAccessToken = await getValidGoogleToken(config.user_id);

            const integrationsResult = await pool.query(
                `SELECT provider, access_token, refresh_token FROM integrations WHERE user_id = $1`,
                [config.user_id]
            );

            const integrations = integrationsResult.rows.reduce((acc, curr) => {
                acc[curr.provider] = {
                    access_token: curr.access_token,
                    refresh_token: curr.refresh_token
                };
                return acc;
            }, {});

            googleRefreshToken = integrations['google']?.refresh_token || null;
            whatsappAccessToken = integrations['whatsapp']?.access_token || null;
            whatsappRefreshToken = integrations['whatsapp']?.refresh_token || null;
        } catch (tokenErr) {
            console.error('[submitFeedback] Token fetch failed:', tokenErr.message);
        }

        const payload = {
            event: 'customer_feedback',
            business_name: config.business_name,
            owner_email: config.owner_email,
            notification_email: config.notification_email || config.owner_email,
            automation_id,
            rating: rating_overall, // Standardized alias
            rating_service,
            rating_product,
            rating_overall,
            comment,
            contact_requested,
            auto_response_message: config.auto_response_message,
            instant_response_template: config.auto_response_message,
            customer: {
                name: customer_name,
                email: customer_email,
                phone: customer_phone
            },
            injected_message: injectPlaceholders(config.auto_response_message, {
                name: customer_name,
                link: `${process.env.FRONTEND_URL}/r/${automation_id}` 
            }),
            // Integration tokens for n8n (Server-side injected for security)
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            access_token: currentGoogleAccessToken || null,
            refresh_token: googleRefreshToken || null,
            whatsapp_access_token: whatsappAccessToken || null,
            whatsapp_refresh_token: whatsappRefreshToken || null
        };

        console.log(`[submitFeedback] Triggering n8n for ${automation_id}...`);

        const reviewFeedbackWebhook = ensureTestUrl(config.n8n_webhook_url || "https://dataanalyst.app.n8n.cloud/webhook-test/review-feedback");
        let n8nResponseData = null;
        let debugStatus = "pending";

        // 5. Trigger review-feedback webhook and WAIT for response to drive the UI
        try {
            const n8nRes = await fetch(reviewFeedbackWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            const rawData = await n8nRes.json();
            const data = Array.isArray(rawData) ? rawData[0] : rawData;

            if (data && (data.action || data.message || data.status === 'success')) {
                n8nResponseData = data;
                debugStatus = "success";
                console.log('[submitFeedback] n8n responded successfully');
            } else {
                debugStatus = "no_action_in_response";
                console.warn('[submitFeedback] n8n returned no valid action/message/status');
            }
        } catch (e) {
            console.error('[submitFeedback] n8n fetch failed:', e.message);
            debugStatus = "error: " + e.message;
        }

        // Secondary fire-and-forget webhooks (Generic lead followup if configured)
        const extraWebhook = ensureTestUrl(config.n8n_webhook_url || process.env.N8N_LEAD_FOLLOWUP_WEBHOOK);
        if (extraWebhook && extraWebhook !== reviewFeedbackWebhook) {
            fetch(extraWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(e => {});
        }
        // 7. DIRECT NATIVE DISPATCH: If the user has a native WhatsApp session, send the message directly
        if (whatsappAccessToken === 'whatsapp_native_session' && customer_phone) {
            const finalMsg = injectPlaceholders(config.auto_response_message, {
                name: customer_name,
                link: `${process.env.FRONTEND_URL}/r/${automation_id}`
            });
            
            try {
                await whatsappService.sendWhatsAppMessage(config.user_id, customer_phone, finalMsg);
                console.log(`[NativeFeedback] Sent feedback confirmation to ${customer_phone}`);
            } catch (dispatchErr) {
                console.error('[NativeFeedback] Failed:', dispatchErr.message);
            }
        }

        // 5. Build Response Object
        const finalResponse = {
            success: true,
            _debug: { n8n_status: debugStatus }
        };

        // If rating is high, prioritize Google Suggestion regardless of n8n override
        if (rating_overall >= 4) {
            finalResponse.action = 'suggest_google';
            finalResponse.message = n8nResponseData?.message || "Thank you! Your feedback is invaluable. Would you mind sharing your experience on Google as well?";
            finalResponse.google_url = config.google_review_url;
        } else if (n8nResponseData) {
            finalResponse.action = n8nResponseData.action || 'message';
            finalResponse.message = n8nResponseData.message || "Feedback received";
            finalResponse.google_url = config.google_review_url;
        } else {
            finalResponse.action = 'message';
            finalResponse.message = "Thank you for your feedback!";
        }

        return res.status(200).json(finalResponse);

    } catch (err) {
        console.error('[submitFeedback] CRITICAL ERR:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /api/l/:automation_id/lead
 */
export const submitLead = async (req, res) => {
    try {
        const { automation_id } = req.params;
        const { full_name, email, phone, message, filtering_responses, captureWebhook, autoResponseWebhook, consent_given, marketing_consent } = req.body;

        if (!full_name || !email || !phone) {
            return res.status(400).json({ success: false, message: 'Please provide full name, email, and phone number.' });
        }

        if (!consent_given) {
            return res.status(400).json({ success: false, message: 'You must agree to be contacted to submit this form.' });
        }

        const result = await pool.query(
            `SELECT rfs.user_id, rfs.lead_capture_active, rfs.auto_response_message, u.email as owner_email
             FROM review_funnel_settings rfs
             JOIN users u ON rfs.user_id = u.id
             WHERE rfs.automation_id = $1`,
            [automation_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }

        if (!result.rows[0].lead_capture_active) {
            return res.status(403).json({ success: false, message: 'This automation is currently disabled by the owner.' });
        }

        const user_id = result.rows[0].user_id;
        const owner_email = result.rows[0].owner_email;
        const current_date = new Date().toISOString();

        // 1. Save Lead to DB
        await pool.query(
            `INSERT INTO leads (user_id, full_name, email, phone, message, filtering_responses, source, consent_given, marketing_consent, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'Public Link', $7, $8, $9)`,
            [user_id, full_name, email, phone, message || '', JSON.stringify(filtering_responses || {}), !!consent_given, !!marketing_consent, current_date]
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
                JSON.stringify({ full_name, email, phone, message: message || '', filtering_responses, consent_given, marketing_consent, date: current_date })
            ]
        );

        // 3. Trigger Webhooks and Handlers
        try {
            const freshGoogleToken = await getValidGoogleToken(user_id);
            const integrationsResult = await pool.query(
                `SELECT provider, access_token, refresh_token FROM integrations WHERE user_id = $1`,
                [user_id]
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

            // DIRECT NATIVE DISPATCH: If the user has a native WhatsApp session, send the message directly
            if (whatsappAuth.access_token === 'whatsapp_native_session') {
                const finalMsg = injectPlaceholders(result.rows[0].auto_response_message, {
                    name: full_name,
                    link: `${process.env.FRONTEND_URL}/l/${automation_id}`
                });
                
                try {
                    await whatsappService.sendWhatsAppMessage(user_id, phone, finalMsg);
                    console.log(`[NativeDispatch] Sent captured lead message to ${phone}`);
                } catch (dispatchErr) {
                    console.error('[NativeDispatch] Failed:', dispatchErr.message);
                }
            }

            // Webhook Payloads for n8n or external triggers
            if (captureWebhook || autoResponseWebhook) {
                const payload = {
                    automation_id,
                    user_id,
                    owner_email,
                    full_name,
                    email,
                    phone,
                    message: message || '',
                    auto_response_message: result.rows[0].auto_response_message,
                    instant_response_template: result.rows[0].auto_response_message,
                    filtering_responses,
                    source: 'Public Link',
                    consent: !!consent_given,
                    marketing_consent: !!marketing_consent,
                    date: current_date,
                    injected_message: injectPlaceholders(result.rows[0].auto_response_message, {
                        name: full_name,
                        link: `${process.env.FRONTEND_URL}/l/${automation_id}`
                    }),

                    client_id: process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    access_token: currentGoogleAccessToken || null,
                    refresh_token: googleAuth.refresh_token || null,
                    whatsapp_access_token: whatsappAuth.access_token || null,
                    whatsapp_refresh_token: whatsappAuth.refresh_token || null
                };

                const finalCaptureWebhook = ensureTestUrl(captureWebhook);
                const finalAutoResponseWebhook = ensureTestUrl(autoResponseWebhook);

                if (finalCaptureWebhook) {
                    fetch(finalCaptureWebhook, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    }).catch(e => {});
                }

                if (finalAutoResponseWebhook) {
                    fetch(finalAutoResponseWebhook, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    }).catch(e => {});
                }
            }
        } catch (webhookErr) {
            console.error('[submitLead] Background logic failed:', webhookErr.message);
        }

        return res.status(200).json({
            success: true,
            status: 'success',
            message: 'Lead Submitted',
            data: { user_id, owner_email, date: current_date }
        });
    } catch (err) {
        console.error('[submitLead] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
