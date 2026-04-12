import pool from '../db/pool.js';
import nodemailer from 'nodemailer';

/**
 * Aggregates weekly stats for a specific user.
 * Period: Last 7 days vs Previous 7 days.
 */
export const getWeeklyStats = async (userId) => {
    const [
        leadsRes, 
        messagesRes, 
        responsesRes, 
        reviewsRes, 
        ratingRes, 
        topDayRes, 
        activeEngineRes
    ] = await Promise.all([
        pool.query("SELECT COUNT(*) as count FROM leads WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM leads WHERE user_id = $1 AND (lead_status = 'Contacted' OR followup_status = 'success') AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM feedback WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND trigger_type IN ('Review Submitted', 'Customer Review') AND status = 'Success' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT AVG(rating_overall) as avg_rating FROM feedback WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT trim(to_char(created_at, 'Day')) as day_name, COUNT(*) FROM activity_logs WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days' GROUP BY day_name ORDER BY count DESC LIMIT 1", [userId]),
        pool.query("SELECT automation_name, COUNT(*) FROM activity_logs WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days' GROUP BY automation_name ORDER BY count DESC LIMIT 1", [userId])
    ]);

    return {
        newLeads: parseInt(leadsRes.rows[0]?.count || 0, 10),
        messagesSent: parseInt(messagesRes.rows[0]?.count || 0, 10),
        responsesReceived: parseInt(responsesRes.rows[0]?.count || 0, 10),
        reviewsCollected: parseInt(reviewsRes.rows[0]?.count || 0, 10),
        avgRating: parseFloat(ratingRes.rows[0]?.avg_rating || 0).toFixed(1),
        topDay: topDayRes.rows[0]?.day_name || 'N/A',
        activeEngine: activeEngineRes.rows[0]?.automation_name || 'N/A'
    };
};

export const generateReportHtml = (user, stats) => {
    // Generate dates for "Week of April 7-13"
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    
    const month = start.toLocaleString('en-US', { month: 'long' });
    let dateStr = '';
    if (start.getMonth() === end.getMonth()) {
        dateStr = `Week of ${month} ${start.getDate()} - ${end.getDate()}, ${end.getFullYear()}`;
    } else {
        const endMonth = end.toLocaleString('en-US', { month: 'short' });
        dateStr = `Week of ${month} ${start.getDate()} - ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
    }

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
        </head>
        <body>
            <style>
                body { 
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; 
                    background-color: #f8fafc; 
                    color: #0f172a; 
                    margin: 0; 
                    padding: 0; 
                    -webkit-font-smoothing: antialiased;
                }
                .wrapper {
                    max-width: 800px;
                    margin: 0 auto;
                    background: #ffffff;
                    border-radius: 16px;
                    overflow: hidden;
                    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
                    border: 1px solid #f1f5f9;
                }
                .header { 
                    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); 
                    padding: 48px 40px; 
                    text-align: left; 
                }
                .header h1 { 
                    color: #ffffff; 
                    margin: 0 0 8px 0; 
                    font-size: 28px; 
                    font-weight: 800; 
                    letter-spacing: -0.02em;
                }
                .header p { 
                    color: #94a3b8; 
                    margin: 0; 
                    font-size: 15px; 
                    font-weight: 500;
                }
                .content { 
                    padding: 40px; 
                }
                .greeting { 
                    font-size: 20px; 
                    font-weight: 600; 
                    color: #0f172a;
                    margin-bottom: 8px; 
                }
                .intro-text {
                    font-size: 15px;
                    color: #64748b;
                    line-height: 1.6;
                    margin-bottom: 32px;
                }
                .grid-container {
                    width: 100%;
                    overflow: hidden;
                    margin-bottom: 32px;
                }
                .stat-card { 
                    float: left;
                    width: calc(50% - 22px);
                    background: #f8fafc; 
                    border: 1px solid #e2e8f0;
                    padding: 24px; 
                    border-radius: 12px; 
                    margin: 0 10px 10px 0;
                }
                .stat-label { 
                    font-size: 13px; 
                    color: #64748b; 
                    font-weight: 600; 
                    text-transform: uppercase; 
                    letter-spacing: 0.06em; 
                    margin-bottom: 12px; 
                }
                .stat-value { 
                    font-size: 32px; 
                    font-weight: 800; 
                    color: #0f172a; 
                    line-height: 1;
                }
                .highlight-section {
                    background: #f0fdf4;
                    border: 1px solid #bbf7d0;
                    border-radius: 12px;
                    padding: 24px;
                    margin-bottom: 32px;
                    overflow: hidden;
                }
                .highlight-grid {
                    width: 100%;
                }
                .highlight-item {
                    float: left;
                    width: 33%;
                    text-align: center;
                }
                .highlight-item .label {
                    font-size: 13px;
                    color: #166534;
                    font-weight: 600;
                    margin-bottom: 8px;
                }
                .highlight-item .value {
                    font-size: 18px;
                    font-weight: 700;
                    color: #14532d;
                }
                .rating-badge {
                    display: inline-flex;
                    align-items: center;
                    background: #fef08a;
                    color: #854d0e;
                    padding: 4px 12px;
                    border-radius: 9999px;
                    font-size: 18px;
                    font-weight: 800;
                }
                .footer { 
                    background: #f8fafc; 
                    padding: 32px 40px; 
                    text-align: center; 
                    border-top: 1px solid #f1f5f9; 
                }
                .footer-logo {
                    font-size: 16px;
                    font-weight: 800;
                    color: #0f172a;
                    margin-bottom: 8px;
                }
                .footer p { 
                    font-size: 13px; 
                    color: #94a3b8; 
                    margin: 0; 
                    line-height: 1.5;
                }
            </style>
            <div style="padding: 20px; background-color: #f8fafc;">
                <div class="wrapper">
                    <div class="header">
                        <h1>Weekly Performance Report</h1>
                        <p>${dateStr}</p>
                    </div>
                    
                    <div class="content">
                        <div class="greeting">Hello ${user.name || user.company_name || 'Partner'},</div>
                        <div class="intro-text">
                            Your automated systems have been working diligently. Here is a snapshot of your platform's performance over the last 7 days.
                        </div>
                        
                        <div class="grid-container">
                            <div class="stat-card">
                                <div class="stat-label">New Leads</div>
                                <div class="stat-value" style="color: #3b82f6;">${stats.newLeads}</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-label">Messages Sent</div>
                                <div class="stat-value" style="color: #ec4899;">${stats.messagesSent > stats.newLeads ? stats.messagesSent : stats.newLeads}</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-label">Responses Received</div>
                                <div class="stat-value" style="color: #f59e0b;">${stats.responsesReceived}</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-label">Google Reviews Collected</div>
                                <div class="stat-value" style="color: #10b981;">${stats.reviewsCollected}</div>
                            </div>
                        </div>

                        <div class="highlight-section">
                            <div class="highlight-grid">
                                <div class="highlight-item" style="border-right: 1px solid #bbf7d0;">
                                    <div class="label">Top Performing Day</div>
                                    <div class="value">${stats.topDay}</div>
                                </div>
                                <div class="highlight-item" style="border-right: 1px solid #bbf7d0;">
                                    <div class="label">Most Active Engine</div>
                                    <div class="value">${stats.activeEngine}</div>
                                </div>
                                <div class="highlight-item">
                                    <div class="label">Average Rating</div>
                                    <div class="rating-badge">⭐ ${stats.avgRating > 0 ? stats.avgRating : 'N/A'}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="footer">
                        <div class="footer-logo">Equipo Experto</div>
                        <p>© ${new Date().getFullYear()} Equipo Experto. All rights reserved.</p>
                        <p style="margin-top: 4px;">This report is automatically generated based on platform activity.</p>
                    </div>
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
        subject: `📈 Weekly Report: ${stats.newLeads} New Leads & ${stats.reviewsCollected} Reviews`,
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
                if (stats.newLeads > 0 || stats.reviewsCollected > 0 || stats.messagesSent > 0) {
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
