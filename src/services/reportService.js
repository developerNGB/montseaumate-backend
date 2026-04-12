import pool from '../db/pool.js';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';

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
    // Generate dates for "Week of April 7-13" (Last 7 days strictly)
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    
    const month = start.toLocaleString('en-US', { month: 'long' });
    let dateStr = '';
    if (start.getMonth() === end.getMonth()) {
        dateStr = `Week of ${month} ${start.getDate()}-${end.getDate()}`;
    } else {
        const endMonth = end.toLocaleString('en-US', { month: 'short' });
        dateStr = `Week of ${month} ${start.getDate()} - ${endMonth} ${end.getDate()}`;
    }

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: 'Inter', Helvetica, Arial, sans-serif; background-color: #f9fafb; color: #111827; margin: 0; padding: 40px; }
                .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
                .header { font-size: 20px; font-weight: 700; margin-bottom: 8px; color: #111827; }
                .divider { color: #d1d5db; letter-spacing: 2px; margin: 15px 0; font-family: monospace; }
                .metric { font-size: 16px; margin: 10px 0; color: #374151; display: flex; align-items: center; }
                .metric-label { font-weight: 400; color: #4b5563; }
                .metric-value { font-weight: 600; color: #111827; margin-left: 6px; }
                .footer { font-size: 14px; color: #6b7280; font-style: italic; margin-top: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">${dateStr}</div>
                <div class="divider">─────────────────</div>
                
                <div class="metric"><span class="metric-label">New Leads:</span> <span class="metric-value">${stats.newLeads}</span></div>
                <div class="metric"><span class="metric-label">Messages Sent:</span> <span class="metric-value">${stats.messagesSent > stats.newLeads ? stats.messagesSent : stats.newLeads}</span></div>
                <div class="metric"><span class="metric-label">Responses Received:</span> <span class="metric-value">${stats.responsesReceived}</span></div>
                <div class="metric"><span class="metric-label">Google Reviews Collected:</span> <span class="metric-value">${stats.reviewsCollected}</span></div>
                <div class="metric"><span class="metric-label">Average Rating:</span> <span class="metric-value">${stats.avgRating > 0 ? stats.avgRating : 'N/A'}</span></div>
                
                <div class="divider">─────────────────</div>
                
                <div class="metric"><span class="metric-label">Top performing day:</span> <span class="metric-value">${stats.topDay}</span></div>
                <div class="metric"><span class="metric-label">Most active engine:</span> <span class="metric-value">${stats.activeEngine}</span></div>
                
                <div class="footer">Report generated for ${user.company_name || user.name || 'Partner'}.</div>
            </div>
        </body>
        </html>
    `;
};

/**
 * Generates a PDF buffer from the HTML report.
 */
export const generateReportPDF = async (user, stats) => {
    const htmlContent = generateReportHtml(user, stats);
    
    // Launch headless browser with flags to support basic cloud environments
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    // Print to PDF
    const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '20px' }
    });
    
    await browser.close();
    return pdfBuffer;
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
