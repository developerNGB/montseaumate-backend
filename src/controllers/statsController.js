import pool from '../db/pool.js';
import {
    getPlanEntitlements,
    isTrialing,
    resolveBillingForEntitlements,
} from '../services/subscriptionPlans.js';
import { sanitizeLeads } from '../utils/leadPrivacy.js';

export const getDashboardStats = async (req, res) => {
    try {
        const userId = req.user.id;

        // Execute all independent queries in parallel for maximum performance
        const [
            leadsRes, 
            reviewsRes, 
            messagesRes, 
            feedbackRes, 
            recipesRes, 
            followUpConfigRes, 
            revTriggerRes, 
            captureTriggerRes, 
            followTriggerRes, 
            pipelineRes,
            leadsSparkRes,
            feedbackSparkRes,
            reviewsSparkRes,
            userBillingRes,
        ] = await Promise.all([
            // 1. Leads
            pool.query(
                "SELECT COUNT(*) as count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent_count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as previous_count FROM leads WHERE user_id = $1",
                [userId]
            ),
            // 2. Reviews
            pool.query(
                "SELECT COUNT(*) as count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent_count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as previous_count FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review'",
                [userId]
            ),
            // 3. Messages
            pool.query(
                "SELECT COUNT(*) as count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent_count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as previous_count FROM leads WHERE user_id = $1 AND followup_status = 'success'",
                [userId]
            ),
            // 4. Feedback
            pool.query(
                "SELECT COUNT(*) as count, AVG(rating_overall) as avg_rating FROM feedback WHERE user_id = $1",
                [userId]
            ),
            // 5. Recipe Config
            pool.query(
                `SELECT is_active, lead_capture_active, google_review_url,
                    COALESCE(review_next_step_done, FALSE) AS review_next_step_done,
                    COALESCE(capture_next_step_done, FALSE) AS capture_next_step_done
                 FROM review_funnel_settings WHERE user_id = $1`,
                [userId]
            ),
            // 6. Follow-up Config
            pool.query(
                "SELECT is_active, COALESCE(followup_next_step_done, FALSE) AS followup_next_step_done FROM lead_followup_settings WHERE user_id = $1",
                [userId]
            ),
            // 7. Last Review Trigger
            pool.query(
                "SELECT MAX(created_at) as last_active FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review'",
                [userId]
            ),
            // 8. Last Capture Trigger
            pool.query(
                "SELECT MAX(created_at) as last_active FROM leads WHERE user_id = $1",
                [userId]
            ),
            // 9. Last Follow-up Trigger
            pool.query(
                "SELECT MAX(updated_at) as last_active FROM leads WHERE user_id = $1 AND followup_status = 'success'",
                [userId]
            ),
            // 10. Pipeline
            pool.query(
                "SELECT id, full_name as name, email, source, followup_status as status, created_at FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5",
                [userId]
            ),
            // 11. Leads sparkline — daily count for last 7 days
            pool.query(
                `SELECT TO_CHAR(DATE(created_at), 'YYYY-MM-DD') as day, COUNT(*)::int as count
                 FROM leads WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
                 GROUP BY DATE(created_at) ORDER BY day ASC`,
                [userId]
            ),
            // 12. Feedback sparkline — daily count for last 7 days
            pool.query(
                `SELECT TO_CHAR(DATE(created_at), 'YYYY-MM-DD') as day, COUNT(*)::int as count
                 FROM feedback WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
                 GROUP BY DATE(created_at) ORDER BY day ASC`,
                [userId]
            ),
            // 13. Reviews sparkline — daily count for last 7 days
            pool.query(
                `SELECT TO_CHAR(DATE(created_at), 'YYYY-MM-DD') as day, COUNT(*)::int as count
                 FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review' AND created_at >= NOW() - INTERVAL '7 days'
                 GROUP BY DATE(created_at) ORDER BY day ASC`,
                [userId]
            ),
            pool.query('SELECT plan, trial_ends_at FROM users WHERE id = $1', [userId]),
        ]);

        const billRow = userBillingRes.rows[0] ?? {};
        const billingResolved = resolveBillingForEntitlements(
            req.user,
            billRow.plan,
            billRow.trial_ends_at
        );
        const planSlug = String(billingResolved.plan).trim();
        const onPaidGrowthOrPro = /^pro$/i.test(planSlug) || /^growth$/i.test(planSlug);

        const leadsReceived = parseInt(leadsRes.rows[0].count, 10);
        const leadsRecent = parseInt(leadsRes.rows[0].recent_count || 0, 10);
        const leadsPrev = parseInt(leadsRes.rows[0].previous_count || 0, 10);

        const reviewsGenerated = parseInt(reviewsRes.rows[0].count, 10);
        const reviewsRecent = parseInt(reviewsRes.rows[0].recent_count || 0, 10);
        const reviewsPrev = parseInt(reviewsRes.rows[0].previous_count || 0, 10);

        const messagesSent = parseInt(messagesRes.rows[0].count, 10);
        const messagesRecent = parseInt(messagesRes.rows[0].recent_count || 0, 10);
        const messagesPrev = parseInt(messagesRes.rows[0].previous_count || 0, 10);

        const totalFeedback = parseInt(feedbackRes.rows[0].count, 10);
        const avgRating = parseFloat(feedbackRes.rows[0].avg_rating || 0).toFixed(1);

        const rfRow = recipesRes.rows[0];
        const reviewFunnelActive = !!rfRow?.is_active;
        const leadCaptureActive = !!rfRow?.lead_capture_active;
        const leadFollowUpActive = !!followUpConfigRes.rows[0]?.is_active;

        const reviewFunnelConfigured = !!rfRow && (
            rfRow.review_next_step_done === true || reviewFunnelActive
        );
        const leadCaptureConfigured = !!rfRow && (
            rfRow.capture_next_step_done === true || leadCaptureActive
        );
        const lfRow = followUpConfigRes.rows[0];
        const leadFollowUpConfigured = !!lfRow && (
            lfRow.followup_next_step_done === true || leadFollowUpActive
        );

        // Build 7-day sparkline arrays. Fill missing days with 0.
        // r.day is already a 'YYYY-MM-DD' string via TO_CHAR
        const buildSparkline = (rows) => {
            const map = {};
            rows.forEach(r => { map[r.day] = r.count; });
            const result = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setUTCHours(0, 0, 0, 0);
                d.setUTCDate(d.getUTCDate() - i);
                const key = d.toISOString().split('T')[0]; // always 'YYYY-MM-DD' UTC
                result.push(map[key] || 0);
            }
            return result;
        };

        const leadsSparkline = buildSparkline(leadsSparkRes.rows);
        const feedbackSparkline = buildSparkline(feedbackSparkRes.rows);
        const reviewsSparkline = buildSparkline(reviewsSparkRes.rows);

        const calculateTrend = (recent, previous) => {
            if (previous === 0) return recent > 0 ? '+100%' : 'No data yet';
            if (recent === 0 && previous === 0) return 'No data yet';
            
            // ELIMINATE SCARY NEGATIVE PERCENTAGES FOR LOW VOLUMES
            // If the business has low volume, any change results in massive % swings that look like bugs.
            if (previous < 10) {
                if (recent >= previous) return 'Growth';
                return 'Tracking';
            }

            const percentage = ((recent - previous) / previous) * 100;
            
            // Safeguard: If we have very few leads (e.g. < 5) and dip, don't show -X%. Show "Maintaining" or "Steady".
            if (percentage < 0 && recent < 5) return 'Steady';

            return percentage > 0 ? `+${Math.round(percentage)}%` : `${Math.round(percentage)}%`;
        };

        // Ensure no caching for stats to prevent stale "Awaiting Setup" states
        res.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.header('Pragma', 'no-cache');
        res.header('Expires', '0');

        return res.status(200).json({
            success: true,
            stats: {
                leadsReceived,
                leadsTrend: calculateTrend(leadsRecent, leadsPrev),
                reviewsGenerated,
                reviewsTrend: calculateTrend(reviewsRecent, reviewsPrev),
                messagesSent,
                messagesTrend: calculateTrend(messagesRecent, messagesPrev),
                totalFeedback,
                avgRating,
                leadsSparkline,
                feedbackSparkline,
                reviewsSparkline
            },
            recipes: {
                reviewFunnel: reviewFunnelActive,
                leadCapture: leadCaptureActive,
                leadFollowUp: leadFollowUpActive
            },
            employeeIntroDone: {
                reviewFunnel: !!(recipesRes.rows[0]?.review_next_step_done),
                leadCapture: !!(recipesRes.rows[0]?.capture_next_step_done),
                leadFollowUp: !!(followUpConfigRes.rows[0]?.followup_next_step_done),
            },
            configured: {
                reviewFunnel: reviewFunnelConfigured,
                leadCapture: leadCaptureConfigured,
                leadFollowUp: leadFollowUpConfigured,
            },
            lastTriggers: {
                reviewFunnel: revTriggerRes.rows[0]?.last_active || null,
                leadCapture: captureTriggerRes.rows[0]?.last_active || null,
                leadFollowUp: followTriggerRes.rows[0]?.last_active || null
            },
            pipeline: sanitizeLeads(pipelineRes.rows),
            billing: {
                plan: billingResolved.plan,
                trial_ends_at: billingResolved.trial_ends_at,
                trial_active: !onPaidGrowthOrPro && isTrialing(billingResolved.trial_ends_at),
                entitlements: getPlanEntitlements(
                    billingResolved.plan,
                    billingResolved.trial_ends_at
                ),
            },
        });

    } catch (err) {
        console.error('[getDashboardStats] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error fetching stats.' });
    }
};

/**
 * Get real-time employee activity status
 * Returns last activity time, pending jobs count, and today's sent count
 */
export const getEmployeeActivityStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        let { employee } = req.query; // 'followup', 'review', or 'capture'

        if (typeof employee === 'string' && employee.includes(':')) {
            employee = employee.split(':')[0];
        }

        if (!employee || !['followup', 'review', 'capture'].includes(employee)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid employee type. Use: followup, review, or capture' 
            });
        }

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        let lastActivity = null;
        let pendingCount = 0;
        let sentToday = 0;
        let isActive = false;
        let detailedStats = {};

        if (employee === 'followup') {
            const [
                lastActivityRes,
                pendingRes,
                sentTodayRes,
                isActiveRes,
                sentRes,
                contactsRes,
                repliedRes
            ] = await Promise.all([
                pool.query(`
                    SELECT MAX(created_at) as last_activity
                    FROM activity_logs
                    WHERE user_id = $1
                    AND automation_name = 'Lead Follow-up'
                    AND status = 'Success'
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as pending_count
                    FROM leads
                    WHERE user_id = $1
                    AND lead_status IN ('New', 'Contacted')
                    AND marketing_consent = true
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as sent_today
                    FROM activity_logs
                    WHERE user_id = $1
                    AND automation_name = 'Lead Follow-up'
                    AND status = 'Success'
                    AND created_at >= $2
                `, [userId, todayStart]),
                pool.query(`
                    SELECT is_active FROM lead_followup_settings WHERE user_id = $1
                `, [userId]),
                // Total individual emails sent (multiple per contact across sequence steps)
                pool.query(`
                    SELECT (
                        SELECT COUNT(*) FROM activity_logs
                        WHERE user_id = $1 AND automation_name = 'Lead Follow-up' AND status = 'Success'
                    ) + (
                        SELECT COALESCE(SUM((metadata::jsonb->>'sent')::int), 0)
                        FROM activity_logs
                        WHERE user_id = $1 AND trigger_type = 'Bulk Trigger' AND status = 'Success'
                    ) as count
                `, [userId]),
                // Unique contacts who received at least one follow-up
                pool.query(`
                    SELECT COUNT(DISTINCT lead_id) as count
                    FROM activity_logs
                    WHERE user_id = $1
                    AND automation_name = 'Lead Follow-up'
                    AND status = 'Success'
                    AND lead_id IS NOT NULL
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM leads
                    WHERE user_id = $1 AND lead_status = 'Replied'
                `, [userId])
            ]);

            lastActivity = lastActivityRes.rows[0]?.last_activity;
            pendingCount = parseInt(pendingRes.rows[0]?.pending_count || 0);
            sentToday = parseInt(sentTodayRes.rows[0]?.sent_today || 0);
            isActive = isActiveRes.rows[0]?.is_active === true;
            detailedStats = {
                sent: parseInt(sentRes.rows[0]?.count || 0),
                contacts: parseInt(contactsRes.rows[0]?.count || 0),
                replied: parseInt(repliedRes.rows[0]?.count || 0)
            };

        } else if (employee === 'review') {
            const [
                lastActivityRes,
                pendingRes,
                sentTodayRes,
                isActiveRes,
                qrScansRes,
                qrAnswersRes,
                qrReviewsRes,
                listSentRes,
                listBouncesRes,
                listAnswersRes,
                listReviewsRes,
                listUnsatisfiedRes
            ] = await Promise.all([
                pool.query(`
                    SELECT MAX(created_at) as last_activity
                    FROM activity_logs 
                    WHERE user_id = $1 
                    AND (trigger_type = 'Customer Review' OR trigger_type = 'Review request')
                    AND status = 'Success'
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as pending_count
                    FROM leads 
                    WHERE user_id = $1 
                    AND id NOT IN (
                        SELECT DISTINCT lead_id FROM activity_logs 
                        WHERE user_id = $1 AND trigger_type = 'Customer Review'
                    )
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as sent_today
                    FROM activity_logs 
                    WHERE user_id = $1 
                    AND (trigger_type = 'Customer Review' OR trigger_type = 'Review request')
                    AND status = 'Success'
                    AND created_at >= $2
                `, [userId, todayStart]),
                pool.query(`
                    SELECT is_active FROM review_funnel_settings WHERE user_id = $1
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM activity_logs 
                    WHERE user_id = $1 AND trigger_type = 'QR Scan'
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM activity_logs 
                    WHERE user_id = $1 
                    AND trigger_type IN ('Feedback Received', 'Customer Review') 
                    AND metadata::jsonb->>'source' = 'qr'
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM activity_logs 
                    WHERE user_id = $1 
                    AND trigger_type = 'Customer Review' 
                    AND status = 'Success' 
                    AND metadata::jsonb->>'source' = 'qr'
                `, [userId]),
                pool.query(`
                    SELECT (
                        SELECT COALESCE(SUM((metadata::jsonb->>'sent')::int), 0) 
                        FROM activity_logs 
                        WHERE user_id = $1 AND trigger_type = 'Review request' AND status = 'Success'
                    ) + (
                        SELECT COUNT(*) 
                        FROM activity_logs 
                        WHERE user_id = $1 AND trigger_type = 'Customer Review' AND status = 'Success' AND metadata::jsonb->>'source' = 'list'
                    ) as count
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM activity_logs 
                    WHERE user_id = $1 AND status = 'Failed' AND (detail LIKE '%Email failed%' OR metadata::jsonb->>'email_attempted' = 'true')
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM activity_logs 
                    WHERE user_id = $1 
                    AND trigger_type IN ('Feedback Received', 'Customer Review') 
                    AND metadata::jsonb->>'source' = 'list'
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM activity_logs 
                    WHERE user_id = $1 
                    AND trigger_type = 'Customer Review' 
                    AND status = 'Success' 
                    AND metadata::jsonb->>'source' = 'list'
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM activity_logs 
                    WHERE user_id = $1 
                    AND trigger_type IN ('Feedback Received', 'Customer Review') 
                    AND status = 'Attention'
                `, [userId])
            ]);

            lastActivity = lastActivityRes.rows[0]?.last_activity;
            pendingCount = parseInt(pendingRes.rows[0]?.pending_count || 0);
            sentToday = parseInt(sentTodayRes.rows[0]?.sent_today || 0);
            isActive = isActiveRes.rows[0]?.is_active === true;
            detailedStats = {
                qr: {
                    scans: parseInt(qrScansRes.rows[0]?.count || 0),
                    answers: parseInt(qrAnswersRes.rows[0]?.count || 0),
                    reviews: parseInt(qrReviewsRes.rows[0]?.count || 0)
                },
                list: {
                    sent: parseInt(listSentRes.rows[0]?.count || 0),
                    bounces: parseInt(listBouncesRes.rows[0]?.count || 0),
                    answers: parseInt(listAnswersRes.rows[0]?.count || 0),
                    reviews: parseInt(listReviewsRes.rows[0]?.count || 0),
                    unsatisfied_alerts: parseInt(listUnsatisfiedRes.rows[0]?.count || 0)
                }
            };

        } else { // capture
            const [
                lastActivityRes,
                pendingRes,
                sentTodayRes,
                isActiveRes,
                formViewsRes,
                completedRes,
                highPriorityRes
            ] = await Promise.all([
                pool.query(`
                    SELECT MAX(created_at) as last_activity
                    FROM leads 
                    WHERE user_id = $1 
                    AND source IN ('QR Survey', 'Website', 'bulk_import', 'Excel Upload', 'Public Link')
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as pending_count
                    FROM leads 
                    WHERE user_id = $1 
                    AND lead_status = 'New'
                    AND created_at >= NOW() - INTERVAL '24 hours'
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as sent_today
                    FROM leads 
                    WHERE user_id = $1 
                    AND created_at >= $2
                `, [userId, todayStart]),
                pool.query(`
                    SELECT lead_capture_active as is_active 
                    FROM review_funnel_settings 
                    WHERE user_id = $1
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM activity_logs 
                    WHERE user_id = $1 AND automation_name = 'Lead Capture Form' AND trigger_type = 'Form View'
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM activity_logs 
                    WHERE user_id = $1 AND automation_name = 'Lead Capture Form' AND trigger_type = 'Lead Subscribed'
                `, [userId]),
                pool.query(`
                    SELECT COUNT(*) as count FROM leads
                    WHERE user_id = $1
                    AND hot_alert_sent_at IS NOT NULL
                `, [userId])
            ]);

            lastActivity = lastActivityRes.rows[0]?.last_activity;
            pendingCount = parseInt(pendingRes.rows[0]?.pending_count || 0);
            sentToday = parseInt(sentTodayRes.rows[0]?.sent_today || 0);
            isActive = isActiveRes.rows[0]?.is_active === true;

            const formViews = parseInt(formViewsRes.rows[0]?.count || 0);
            const completed = parseInt(completedRes.rows[0]?.count || 0);
            const abandoned = Math.max(0, formViews - completed);

            detailedStats = {
                form_views: formViews,
                completed: completed,
                abandoned: abandoned,
                high_priority: parseInt(highPriorityRes.rows[0]?.count || 0)
            };
        }

        // Determine status
        let status = 'off_duty';
        if (isActive) {
            const lastActivityTime = lastActivity ? new Date(lastActivity) : null;
            const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
            
            if (pendingCount > 0 || (lastActivityTime && lastActivityTime > fiveMinutesAgo)) {
                status = 'working';
            } else {
                status = 'idle';
            }
        }

        return res.json({
            success: true,
            employee,
            status,
            is_active: isActive,
            last_activity: lastActivity,
            pending_count: pendingCount,
            sent_today: sentToday,
            detailed_stats: detailedStats
        });

    } catch (err) {
        console.error('[getEmployeeActivityStatus] Error:', err.message, err.stack);
        return res.status(500).json({ success: false, message: 'Server error fetching activity status.', error: err.message });
    }
};

