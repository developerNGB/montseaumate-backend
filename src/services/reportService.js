import pool from '../db/pool.js';
import nodemailer from 'nodemailer';

/**
 * Aggregates weekly stats for a specific user.
 * Period: Last 7 days vs Previous 7 days.
 */
export const getWeeklyStats = async (userId) => {
    const [leadsRes, reviewsRes, messagesRes, feedbackRes] = await Promise.all([
        // 1. Leads
        pool.query(
            "SELECT SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent_count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as previous_count FROM leads WHERE user_id = $1",
            [userId]
        ),
        // 2. Reviews
        pool.query(
            "SELECT SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent_count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as previous_count FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review'",
            [userId]
        ),
        // 3. Messages
        pool.query(
            "SELECT SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent_count, SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as previous_count FROM leads WHERE user_id = $1 AND followup_status = 'success'",
            [userId]
        ),
        // 4. Feedback
        pool.query(
            "SELECT AVG(rating_overall) as avg_rating FROM feedback WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'",
            [userId]
        )
    ]);

    const recentLeads = parseInt(leadsRes.rows[0].recent_count || 0, 10);
    const prevLeads = parseInt(leadsRes.rows[0].previous_count || 0, 10);
    const recentReviews = parseInt(reviewsRes.rows[0].recent_count || 0, 10);
    const prevReviews = parseInt(reviewsRes.rows[0].previous_count || 0, 10);
    const recentMessages = parseInt(messagesRes.rows[0].recent_count || 0, 10);
    const prevMessages = parseInt(messagesRes.rows[0].previous_count || 0, 10);
    const avgRating = parseFloat(feedbackRes.rows[0].avg_rating || 0).toFixed(1);

    const calculateTrend = (recent, previous) => {
        if (previous === 0) return recent > 0 ? '+100%' : '0%';
        const percentage = Math.round(((recent - previous) / previous) * 100);
        return percentage >= 0 ? `+${percentage}%` : `${percentage}%`;
    };

    return {
        leads: { count: recentLeads, trend: calculateTrend(recentLeads, prevLeads) },
        reviews: { count: recentReviews, trend: calculateTrend(recentReviews, prevReviews) },
        messages: { count: recentMessages, trend: calculateTrend(recentMessages, prevMessages) },
        avgRating
    };
};

export const generateReportHtml = (user, stats) => {
    const isPositive = (trend) => !trend.startsWith('-') && trend !== '0%';
    const trendColor = (trend) => isPositive(trend) ? '#10b981' : '#6b7280';

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: 'Inter', Helvetica, Arial, sans-serif; background-color: #f9fafb; color: #111827; margin: 0; padding: 20px; }
                .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
                .header { background: #15803d; padding: 40px 20px; text-align: center; }
                .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; }
                .header p { color: rgba(255, 255, 255, 0.8); margin: 8px 0 0; }
                .content { padding: 40px 30px; }
                .greeting { font-size: 18px; font-weight: 600; margin-bottom: 24px; }
                .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
                .stat-card { background: #f3f4f6; padding: 20px; border-radius: 12px; }
                .stat-label { font-size: 12px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
                .stat-value { font-size: 28px; font-weight: 800; color: #111827; }
                .stat-trend { font-size: 14px; font-weight: 600; margin-top: 4px; }
                .footer { background: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb; }
                .footer p { font-size: 12px; color: #9ca3af; margin: 0; }
                .cta-btn { display: inline-block; background: #15803d; color: #ffffff !important; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; margin-top: 20px; }
                .rating-pill { display: inline-block; background: #fef3c7; color: #92400e; padding: 4px 12px; border-radius: 9999px; font-size: 14px; font-weight: 700; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Weekly Performance Report</h1>
                    <p>${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
                </div>
                <div class="content">
                    <div class="greeting">Hi ${user.name || user.company_name || 'Partner'},</div>
                    <p>Your digital employee has been busy! Here is how your business performed over the last 7 days.</p>
                    
                    <div style="margin-top: 30px;">
                        <table width="100%" cellspacing="0" cellpadding="0" style="table-layout: fixed;">
                            <tr>
                                <td style="padding: 10px;">
                                    <div class="stat-card">
                                        <div class="stat-label">New Leads</div>
                                        <div class="stat-value">${stats.leads.count}</div>
                                        <div class="stat-trend" style="color: ${trendColor(stats.leads.trend)}">${stats.leads.trend} vs last week</div>
                                    </div>
                                </td>
                                <td style="padding: 10px;">
                                    <div class="stat-card">
                                        <div class="stat-label">Reviews Sent</div>
                                        <div class="stat-value">${stats.reviews.count}</div>
                                        <div class="stat-trend" style="color: ${trendColor(stats.reviews.trend)}">${stats.reviews.trend} vs last week</div>
                                    </div>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 10px;">
                                    <div class="stat-card">
                                        <div class="stat-label">Messages Sent</div>
                                        <div class="stat-value">${stats.messages.count}</div>
                                        <div class="stat-trend" style="color: ${trendColor(stats.messages.trend)}">${stats.messages.trend} vs last week</div>
                                    </div>
                                </td>
                                <td style="padding: 10px;">
                                    <div class="stat-card">
                                        <div class="stat-label">Avg Rating</div>
                                        <div class="stat-value">${stats.avgRating}</div>
                                        <div class="rating-pill">⭐ Satisfaction</div>
                                    </div>
                                </td>
                            </tr>
                        </table>
                    </div>

                    <div style="text-align: center; margin-top: 10px;">
                        <a href="https://www.equipoexperto.com/dashboard" class="cta-btn">View Detailed Analytics</a>
                    </div>
                </div>
                <div class="footer">
                    <p>© ${new Date().getFullYear()} Equipo Experto. All rights reserved.</p>
                    <p style="margin-top: 8px;">You are receiving this because weekly reports are enabled for your account.</p>
                </div>
            </div>
        </body>
        </html>
    `;
};

/**
 * Sends the Weekly Report Email
 */
export const sendWeeklyReport = async (user, stats) => {
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true, // use SSL
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    const htmlContent = generateReportHtml(user, stats);

    const mailOptions = {
        from: `"Equipo Experto" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: `📈 Weekly Report: ${stats.leads.count} New Leads & ${stats.reviews.count} Reviews`,
        html: htmlContent
    };

    return transporter.sendMail(mailOptions);
};

/**
 * Main function to run the batch reporting job
 */
export const runWeeklyReportsJob = async () => {
    try {
        console.log('[WeeklyReportsJob] Starting batch processing...');
        
        // Fetch all users who have reports enabled
        const usersRes = await pool.query(
            "SELECT id, name, company_name, email FROM users WHERE weekly_reports_enabled = true"
        );

        console.log(`[WeeklyReportsJob] Processing ${usersRes.rows.length} users.`);

        for (const user of usersRes.rows) {
            try {
                const stats = await getWeeklyStats(user.id);
                // Only send if there was at least some activity (Optional: remove if you want to send zero reports)
                if (stats.leads.count > 0 || stats.reviews.count > 0 || stats.messages.count > 0) {
                    await sendWeeklyReport(user, stats);
                    console.log(`[WeeklyReportsJob] Sent to ${user.email} ✓`);
                } else {
                    console.log(`[WeeklyReportsJob] Skipped ${user.email} (No activity)`);
                }
            } catch (userErr) {
                console.error(`[WeeklyReportsJob] Failed for ${user.email}:`, userErr.message);
            }
        }

        console.log('[WeeklyReportsJob] Batch processing completed.');
    } catch (err) {
        console.error('[WeeklyReportsJob] CRITICAL ERROR:', err.message);
    }
};
