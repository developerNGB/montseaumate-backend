import pool from '../db/pool.js';
import nodemailer from 'nodemailer';

const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

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
            reviewsSparkRes
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
                "SELECT is_active, lead_capture_active FROM review_funnel_settings WHERE user_id = $1",
                [userId]
            ),
            // 6. Follow-up Config
            pool.query(
                "SELECT is_active FROM lead_followup_settings WHERE user_id = $1",
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
        ]);

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

        const reviewFunnelActive = !!recipesRes.rows[0]?.is_active;
        const leadCaptureActive = !!recipesRes.rows[0]?.lead_capture_active;
        const leadFollowUpActive = !!followUpConfigRes.rows[0]?.is_active;

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
            configured: {
                // More precise configuration checks
                reviewFunnel: !!recipesRes.rows[0]?.is_active,
                leadCapture: !!recipesRes.rows[0]?.lead_capture_active,
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

/**
 * POST /api/stats/monthly-report
 * Emails the business owner a monthly summary of their stats.
 */
export const sendMonthlyReport = async (req, res) => {
    try {
        const userId = req.user.id;

        // Fetch user email + name
        const userRes = await pool.query(
            'SELECT name, email, company_name FROM users WHERE id = $1',
            [userId]
        );
        if (!userRes.rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
        const { name, email, company_name } = userRes.rows[0];

        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

        // Gather this month's stats in parallel
        const [leadsRes, reviewsRes, msgsRes, feedbackRes] = await Promise.all([
            pool.query(
                "SELECT COUNT(*)::int as count FROM leads WHERE user_id = $1 AND created_at >= $2",
                [userId, monthStart]
            ),
            pool.query(
                "SELECT COUNT(*)::int as count FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review' AND created_at >= $2",
                [userId, monthStart]
            ),
            pool.query(
                "SELECT COUNT(*)::int as count FROM leads WHERE user_id = $1 AND followup_status = 'success' AND created_at >= $2",
                [userId, monthStart]
            ),
            pool.query(
                "SELECT COUNT(*)::int as count, COALESCE(AVG(rating_overall),0)::numeric(3,1) as avg FROM feedback WHERE user_id = $1 AND created_at >= $2",
                [userId, monthStart]
            ),
        ]);

        const leads = leadsRes.rows[0].count;
        const reviews = reviewsRes.rows[0].count;
        const messages = msgsRes.rows[0].count;
        const feedback = feedbackRes.rows[0].count;
        const avgRating = parseFloat(feedbackRes.rows[0].avg).toFixed(1);

        const html = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:auto;background:#f8fafb;padding:32px;border-radius:16px;">
            <div style="background:#0a1628;border-radius:12px;padding:28px 32px;margin-bottom:24px;text-align:center;">
                <h1 style="color:#22c55e;margin:0;font-size:22px;letter-spacing:-0.5px;">Monthly Performance Report</h1>
                <p style="color:#8896ab;margin:8px 0 0;font-size:14px;">${monthName} · ${company_name || name}</p>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
                ${[
                    { label: 'New Leads', value: leads, color: '#6366f1', icon: '👤' },
                    { label: 'Google Reviews', value: reviews, color: '#f59e0b', icon: '⭐' },
                    { label: 'Messages Sent', value: messages, color: '#10b981', icon: '💬' },
                    { label: 'Feedback Responses', value: feedback, color: '#3b82f6', icon: '📊' },
                ].map(s => `
                    <div style="background:white;border-radius:12px;padding:20px;border:1px solid #e2e8f0;">
                        <p style="margin:0 0 6px;font-size:22px;">${s.icon}</p>
                        <p style="margin:0;font-size:28px;font-weight:900;color:${s.color};">${s.value}</p>
                        <p style="margin:4px 0 0;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">${s.label}</p>
                    </div>
                `).join('')}
            </div>

            ${parseFloat(avgRating) > 0 ? `
            <div style="background:white;border-radius:12px;padding:20px;border:1px solid #e2e8f0;margin-bottom:24px;text-align:center;">
                <p style="margin:0;font-size:13px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Average Customer Rating This Month</p>
                <p style="margin:8px 0 0;font-size:40px;font-weight:900;color:#f59e0b;">${avgRating} <span style="font-size:24px;">⭐</span></p>
            </div>` : ''}

            <p style="color:#64748b;font-size:13px;text-align:center;margin:0;">
                Generated by <strong>Montseaumate</strong> · Your Digital Employee Platform<br>
                <span style="opacity:0.6;">${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
            </p>
        </div>`;

        await mailer.sendMail({
            from: `"Montseaumate" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `📊 Your ${monthName} Report — ${company_name || name}`,
            html,
        });

        return res.status(200).json({ success: true, message: `Report sent to ${email}` });
    } catch (err) {
        console.error('[sendMonthlyReport] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to send report. Please try again.' });
    }
};

