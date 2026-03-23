import pool from '../db/pool.js';

export const getDashboardStats = async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Leads Received (All leads for this user)
        const leadsRes = await pool.query(
            "SELECT COUNT(*) as count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent_count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as previous_count FROM leads WHERE user_id = $1",
            [userId]
        );
        const leadsReceived = parseInt(leadsRes.rows[0].count, 10);
        const leadsRecent = parseInt(leadsRes.rows[0].recent_count || 0, 10);
        const leadsPrev = parseInt(leadsRes.rows[0].previous_count || 0, 10);

        // 2. Reviews Generated (Count of 'Customer Review' in activity_logs)
        const reviewsRes = await pool.query(
            "SELECT COUNT(*) as count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent_count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as previous_count FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review'",
            [userId]
        );
        const reviewsGenerated = parseInt(reviewsRes.rows[0].count, 10);
        const reviewsRecent = parseInt(reviewsRes.rows[0].recent_count || 0, 10);
        const reviewsPrev = parseInt(reviewsRes.rows[0].previous_count || 0, 10);

        // 3. Messages Sent (Count of successfully sent follow-ups)
        const messagesRes = await pool.query(
            "SELECT COUNT(*) as count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent_count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as previous_count FROM leads WHERE user_id = $1 AND followup_status = 'success'",
            [userId]
        );
        const messagesSent = parseInt(messagesRes.rows[0].count, 10);
        const messagesRecent = parseInt(messagesRes.rows[0].recent_count || 0, 10);
        const messagesPrev = parseInt(messagesRes.rows[0].previous_count || 0, 10);

        // 4. Feedback Stats
        const feedbackRes = await pool.query(
            "SELECT COUNT(*) as count, AVG(rating_overall) as avg_rating FROM feedback WHERE user_id = $1",
            [userId]
        );
        const totalFeedback = parseInt(feedbackRes.rows[0].count, 10);
        const avgRating = parseFloat(feedbackRes.rows[0].avg_rating || 0).toFixed(1);

        const calculateTrend = (recent, previous) => {
            if (previous === 0) {
                return recent > 0 ? '+100%' : '0%';
            }
            const increase = recent - previous;
            const percentage = (increase / previous) * 100;
            return percentage > 0 ? `+${Math.round(percentage)}%` : `${Math.round(percentage)}%`;
        };

        const recipesRes = await pool.query(
            "SELECT is_active, lead_capture_active FROM review_funnel_settings WHERE user_id = $1",
            [userId]
        );
        const reviewFunnelActive = !!recipesRes.rows[0]?.is_active;
        const leadCaptureActive = !!recipesRes.rows[0]?.lead_capture_active;

        const followUpConfigRes = await pool.query(
            "SELECT is_active FROM lead_followup_settings WHERE user_id = $1",
            [userId]
        );
        const leadFollowUpActive = !!followUpConfigRes.rows[0]?.is_active;

        const revTriggerRes = await pool.query(
            "SELECT MAX(created_at) as last_active FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review'",
            [userId]
        );
        const captureTriggerRes = await pool.query(
            "SELECT MAX(created_at) as last_active FROM leads WHERE user_id = $1",
            [userId]
        );
        const followTriggerRes = await pool.query(
            "SELECT MAX(updated_at) as last_active FROM leads WHERE user_id = $1 AND followup_status = 'success'",
            [userId]
        );

        const pipelineRes = await pool.query(
            "SELECT id, full_name as name, email, source, followup_status as status, created_at FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5",
            [userId]
        );

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
                reviewFunnel: !!recipesRes.rows[0],
                leadCapture: !!recipesRes.rows[0],
                leadFollowUp: !!followUpConfigRes.rows[0]
            },
            lastTriggers: {
                reviewFunnel: revTriggerRes.rows[0]?.last_active || null,
                leadCapture: captureTriggerRes.rows[0]?.last_active || null,
                leadFollowUp: followTriggerRes.rows[0]?.last_active || null
            },
            pipeline: pipelineRes.rows
        });

    } catch (err) {
        console.error('[getDashboardStats] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error fetching stats.' });
    }
};
