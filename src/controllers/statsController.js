import pool from '../db/pool.js';

export const getDashboardStats = async (req, res) => {
    try {
        const userId = req.user.id;

        // Execute all independent queries in parallel for maximum performance
        const [
            leadsStatsRes,
            activityStatsRes,
            feedbackStatsRes,
            configStatsRes,
            pipelineRes
        ] = await Promise.all([
            // 1. Consolidated Leads Stats
            pool.query(
                `SELECT 
                    COUNT(*) as total_leads,
                    SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as leads_recent,
                    SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as leads_prev,
                    SUM(CASE WHEN followup_status = 'success' THEN 1 ELSE 0 END) as total_messages,
                    SUM(CASE WHEN followup_status = 'success' AND created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as messages_recent,
                    SUM(CASE WHEN followup_status = 'success' AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as messages_prev,
                    MAX(created_at) as last_capture,
                    MAX(CASE WHEN followup_status = 'success' THEN updated_at ELSE NULL END) as last_followup
                FROM leads WHERE user_id = $1`,
                [userId]
            ),
            // 2. Consolidated Activity/Review Stats
            pool.query(
                `SELECT 
                    COUNT(*) as total_reviews,
                    SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as reviews_recent,
                    SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as reviews_prev,
                    MAX(created_at) as last_review
                FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review'`,
                [userId]
            ),
            // 3. Feedback Stats
            pool.query(
                "SELECT COUNT(*) as count, AVG(rating_overall) as avg_rating FROM feedback WHERE user_id = $1",
                [userId]
            ),
            // 4. Recipe Configurations
            pool.query(
                `SELECT 
                    rfs.is_active as review_active, 
                    rfs.lead_capture_active, 
                    rfs.google_review_url,
                    lfs.is_active as followup_active,
                    lfs.id as followup_id
                FROM users u
                LEFT JOIN review_funnel_settings rfs ON u.id = rfs.user_id
                LEFT JOIN lead_followup_settings lfs ON u.id = lfs.user_id
                WHERE u.id = $1`,
                [userId]
            ),
            // 5. Pipeline
            pool.query(
                "SELECT id, full_name as name, email, source, followup_status as status, created_at FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5",
                [userId]
            )
        ]);

        const leadsRow = leadsStatsRes.rows[0];
        const activityRow = activityStatsRes.rows[0];
        const feedbackRow = feedbackStatsRes.rows[0];
        const configRow = configStatsRes.rows[0];

        const leadsReceived = parseInt(leadsRow.total_leads || 0, 10);
        const leadsRecent = parseInt(leadsRow.leads_recent || 0, 10);
        const leadsPrev = parseInt(leadsRow.leads_prev || 0, 10);

        const reviewsGenerated = parseInt(activityRow.total_reviews || 0, 10);
        const reviewsRecent = parseInt(activityRow.reviews_recent || 0, 10);
        const reviewsPrev = parseInt(activityRow.reviews_prev || 0, 10);

        const messagesSent = parseInt(leadsRow.total_messages || 0, 10);
        const messagesRecent = parseInt(leadsRow.messages_recent || 0, 10);
        const messagesPrev = parseInt(leadsRow.messages_prev || 0, 10);

        const totalFeedback = parseInt(feedbackRow.count || 0, 10);
        const avgRating = parseFloat(feedbackRow.avg_rating || 0).toFixed(1);

        const reviewFunnelActive = !!configRow?.review_active;
        const leadCaptureActive = !!configRow?.lead_capture_active;
        const leadFollowUpActive = !!configRow?.followup_active;

        const calculateTrend = (recent, previous) => {
            if (previous === 0) return recent > 0 ? '+100%' : '0%';
            const percentage = ((recent - previous) / previous) * 100;
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
                avgRating
            },
            recipes: {
                reviewFunnel: reviewFunnelActive,
                leadCapture: leadCaptureActive,
                leadFollowUp: leadFollowUpActive
            },
            configured: {
                reviewFunnel: !!configRow?.google_review_url,
                leadCapture: !!configRow?.lead_capture_active,
                leadFollowUp: !!configRow?.followup_id
            },
            lastTriggers: {
                reviewFunnel: activityRow?.last_review || null,
                leadCapture: leadsRow?.last_capture || null,
                leadFollowUp: leadsRow?.last_followup || null
            },
            pipeline: pipelineRes.rows
        });

    } catch (err) {
        console.error('[getDashboardStats] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error fetching stats.' });
    }
};
