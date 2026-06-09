import pool from '../db/pool.js';
import nodemailer from 'nodemailer';
import { sendDynamicEmail } from './emailService.js';
import PDFDocument from 'pdfkit';

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
        activeEngineRes,
        
        qrScansRes,
        qrAnswersRes,
        qrReviewsRes,
        
        listSentRes,
        listBouncesRes,
        listAnswersRes,
        listReviewsRes,
        listUnsatisfiedRes,
        
        formViewsRes,
        completedRes,
        highPriorityRes,
        
        followupSentRes,
        followupContactsRes,
        followupAnsweredRes
    ] = await Promise.all([
        pool.query("SELECT COUNT(*) as count FROM leads WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM leads WHERE user_id = $1 AND (lead_status = 'Contacted' OR followup_status = 'success') AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM feedback WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND trigger_type IN ('Review Submitted', 'Customer Review') AND status = 'Success' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT AVG(rating_overall) as avg_rating FROM feedback WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT trim(to_char(created_at, 'Day')) as day_name, COUNT(*) FROM activity_logs WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days' GROUP BY day_name ORDER BY count DESC LIMIT 1", [userId]),
        pool.query("SELECT automation_name, COUNT(*) FROM activity_logs WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days' GROUP BY automation_name ORDER BY count DESC LIMIT 1", [userId]),
        
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND trigger_type = 'QR Scan' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND trigger_type IN ('Feedback Received', 'Customer Review') AND metadata::jsonb->>'source' = 'qr' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review' AND status = 'Success' AND metadata::jsonb->>'source' = 'qr' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        
        pool.query(`
            SELECT (
                SELECT COALESCE(SUM((metadata::jsonb->>'sent')::int), 0) 
                FROM activity_logs 
                WHERE user_id = $1 AND trigger_type = 'Review request' AND status = 'Success' AND created_at >= NOW() - INTERVAL '7 days'
            ) + (
                SELECT COUNT(*) 
                FROM activity_logs 
                WHERE user_id = $1 AND trigger_type = 'Customer Review' AND status = 'Success' AND metadata::jsonb->>'source' = 'list' AND created_at >= NOW() - INTERVAL '7 days'
            ) as count
        `, [userId]),
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND status = 'Failed' AND (detail LIKE '%Email failed%' OR metadata::jsonb->>'email_attempted' = 'true') AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND trigger_type IN ('Feedback Received', 'Customer Review') AND metadata::jsonb->>'source' = 'list' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND trigger_type = 'Customer Review' AND status = 'Success' AND metadata::jsonb->>'source' = 'list' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND trigger_type IN ('Feedback Received', 'Customer Review') AND status = 'Attention' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND automation_name = 'Lead Capture Form' AND trigger_type = 'Form View' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND automation_name = 'Lead Capture Form' AND trigger_type = 'Lead Subscribed' AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        pool.query("SELECT COUNT(*) as count FROM leads WHERE user_id = $1 AND filtering_responses IS NOT NULL AND filtering_responses != '{}'::jsonb AND created_at >= NOW() - INTERVAL '7 days'", [userId]),
        
        // Total emails sent (multiple per contact)
        pool.query(`
            SELECT (
                SELECT COUNT(*) FROM activity_logs
                WHERE user_id = $1 AND automation_name = 'Lead Follow-up' AND status = 'Success' AND created_at >= NOW() - INTERVAL '7 days'
            ) + (
                SELECT COALESCE(SUM((metadata::jsonb->>'sent')::int), 0)
                FROM activity_logs
                WHERE user_id = $1 AND trigger_type = 'Bulk Trigger' AND status = 'Success' AND created_at >= NOW() - INTERVAL '7 days'
            ) as count
        `, [userId]),
        // Unique contacts who received a follow-up this week
        pool.query(`
            SELECT COUNT(DISTINCT lead_id) as count
            FROM activity_logs
            WHERE user_id = $1
            AND automation_name = 'Lead Follow-up'
            AND status = 'Success'
            AND lead_id IS NOT NULL
            AND created_at >= NOW() - INTERVAL '7 days'
        `, [userId]),
        pool.query("SELECT COUNT(*) as count FROM leads WHERE user_id = $1 AND lead_status = 'Replied' AND updated_at >= NOW() - INTERVAL '7 days'", [userId])
    ]);

    const formViews = parseInt(formViewsRes.rows[0]?.count || 0, 10);
    const completed = parseInt(completedRes.rows[0]?.count || 0, 10);
    const abandoned = Math.max(0, formViews - completed);

    return {
        newLeads: parseInt(leadsRes.rows[0]?.count || 0, 10),
        messagesSent: parseInt(messagesRes.rows[0]?.count || 0, 10),
        responsesReceived: parseInt(responsesRes.rows[0]?.count || 0, 10),
        reviewsCollected: parseInt(reviewsRes.rows[0]?.count || 0, 10),
        avgRating: parseFloat(ratingRes.rows[0]?.avg_rating || 0).toFixed(1),
        topDay: topDayRes.rows[0]?.day_name || 'N/A',
        activeEngine: activeEngineRes.rows[0]?.automation_name || 'N/A',
        
        employeeReviewsQr: {
            scans: parseInt(qrScansRes.rows[0]?.count || 0, 10),
            answers: parseInt(qrAnswersRes.rows[0]?.count || 0, 10),
            reviews: parseInt(qrReviewsRes.rows[0]?.count || 0, 10)
        },
        employeeReviewsList: {
            sent: parseInt(listSentRes.rows[0]?.count || 0, 10),
            bounces: parseInt(listBouncesRes.rows[0]?.count || 0, 10),
            answers: parseInt(listAnswersRes.rows[0]?.count || 0, 10),
            reviews: parseInt(listReviewsRes.rows[0]?.count || 0, 10),
            unsatisfied: parseInt(listUnsatisfiedRes.rows[0]?.count || 0, 10)
        },
        employeeLeadScoring: {
            formViews,
            completed,
            abandoned,
            highPriority: parseInt(highPriorityRes.rows[0]?.count || 0, 10)
        },
        employeeFollowup: {
            contacts: parseInt(followupContactsRes.rows[0]?.count || 0, 10),
            sent: parseInt(followupSentRes.rows[0]?.count || 0, 10),
            replied: parseInt(followupAnsweredRes.rows[0]?.count || 0, 10)
        }
    };
};

export const generateReportHtml = (user, stats) => {
    // Generate dates for report week
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
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Weekly Performance Report</title>
        </head>
        <body style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0b0f19; color: #f1f5f9; margin: 0; padding: 20px; -webkit-font-smoothing: antialiased;">
            <div style="max-width: 650px; margin: 0 auto; background: #111827; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3); border: 1px solid #1f2937;">
                
                <!-- HEADER -->
                <div style="background: linear-gradient(135deg, #1e1b4b 0%, #311042 100%); padding: 40px; border-bottom: 1px solid #2e1065;">
                    <h1 style="color: #ffffff; margin: 0 0 8px 0; font-size: 24px; font-weight: 800; letter-spacing: -0.02em;">Weekly Performance Report</h1>
                    <p style="color: #a5b4fc; margin: 0; font-size: 14px; font-weight: 500;">${dateStr}</p>
                </div>
                
                <!-- CONTENT -->
                <div style="padding: 30px;">
                    <div style="font-size: 18px; font-weight: 600; color: #ffffff; margin-bottom: 6px;">Hello ${user.name || user.company_name || 'Partner'},</div>
                    <div style="font-size: 14px; color: #9ca3af; line-height: 1.5; margin-bottom: 24px;">
                        Your digital employees have been actively driving results. Here is your detailed productivity report from the last 7 days.
                    </div>
                    
                    <!-- HIGH-LEVEL SNAPSHOT -->
                    <h3 style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #6366f1; letter-spacing: 0.1em; margin: 0 0 16px 0;">Overview Performance</h3>
                    <div style="display: flex; flex-direction: row; flex-wrap: wrap; gap: 12px; margin-bottom: 24px;">
                        <div style="flex: 1; min-width: 130px; background: #1f2937; border: 1px solid #374151; padding: 16px; border-radius: 12px; text-align: center;">
                            <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600; margin-bottom: 6px;">New Leads</div>
                            <div style="font-size: 24px; font-weight: 800; color: #3b82f6;">${stats.newLeads}</div>
                        </div>
                        <div style="flex: 1; min-width: 130px; background: #1f2937; border: 1px solid #374151; padding: 16px; border-radius: 12px; text-align: center;">
                            <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600; margin-bottom: 6px;">Google Reviews</div>
                            <div style="font-size: 24px; font-weight: 800; color: #10b981;">${stats.reviewsCollected}</div>
                        </div>
                        <div style="flex: 1; min-width: 130px; background: #1f2937; border: 1px solid #374151; padding: 16px; border-radius: 12px; text-align: center;">
                            <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600; margin-bottom: 6px;">Rating</div>
                            <div style="font-size: 24px; font-weight: 800; color: #f59e0b;">⭐ ${stats.avgRating > 0 ? stats.avgRating : 'N/A'}</div>
                        </div>
                    </div>

                    <!-- EMPLOYEES LOGS -->
                    <h3 style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #6366f1; letter-spacing: 0.1em; margin: 0 0 16px 0;">Digital Employee Productivity</h3>
                    
                    <!-- EMPLOYEE: REVIEWS (QR) -->
                    <div style="background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                            <div style="background: rgba(99, 102, 241, 0.1); color: #818cf8; width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 18px; font-weight: bold;">📱</div>
                            <div style="font-size: 14px; font-weight: 700; color: #ffffff;">Employee: Reviews (QR Code Funnel)</div>
                        </div>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">QR Code Scans</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #ffffff;">${stats.employeeReviewsQr.scans}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">Completed QR Surveys</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #ffffff;">${stats.employeeReviewsQr.answers}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #9ca3af;">Google Reviews Left</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #10b981;">${stats.employeeReviewsQr.reviews}</td>
                            </tr>
                        </table>
                    </div>

                    <!-- EMPLOYEE: REVIEWS (UPLOAD LIST) -->
                    <div style="background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                            <div style="background: rgba(168, 85, 247, 0.1); color: #c084fc; width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 18px; font-weight: bold;">📊</div>
                            <div style="font-size: 14px; font-weight: 700; color: #ffffff;">Employee: Reviews (Spreadsheet Imports)</div>
                        </div>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">Questionnaires Sent</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #ffffff;">${stats.employeeReviewsList.sent}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">Emails Bounced</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #ef4444;">${stats.employeeReviewsList.bounces}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">Completed Questionnaires</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #ffffff;">${stats.employeeReviewsList.answers}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">Google Reviews Left</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #10b981;">${stats.employeeReviewsList.reviews}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #9ca3af;">Unsatisfied Customer Alerts</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #f59e0b;">${stats.employeeReviewsList.unsatisfied}</td>
                            </tr>
                        </table>
                    </div>

                    <!-- EMPLOYEE: LEAD CAPTURE & SCORING -->
                    <div style="background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                            <div style="background: rgba(236, 72, 153, 0.1); color: #f472b6; width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 18px; font-weight: bold;">⚡</div>
                            <div style="font-size: 14px; font-weight: 700; color: #ffffff;">Employee: Lead Scoring & Web Forms</div>
                        </div>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">Form Views</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #ffffff;">${stats.employeeLeadScoring.formViews}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">Completed Inquiries</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #ffffff;">${stats.employeeLeadScoring.completed}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">High-Priority Notifications</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #f59e0b;">${stats.employeeLeadScoring.highPriority}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #9ca3af;">Abandoned Questionnaires</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #9ca3af;">${stats.employeeLeadScoring.abandoned}</td>
                            </tr>
                        </table>
                    </div>

                    <!-- EMPLOYEE: AUTOMATIC FOLLOW-UP -->
                    <div style="background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                            <div style="background: rgba(14, 165, 233, 0.1); color: #38bdf8; width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 18px; font-weight: bold;">✉️</div>
                            <div style="font-size: 14px; font-weight: 700; color: #ffffff;">Employee: Follow-up Sequences</div>
                        </div>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">Contacts in Sequence</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #ffffff;">${stats.employeeFollowup.contacts}</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #374151;">
                                <td style="padding: 8px 0; color: #9ca3af;">Total Emails Sent</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #ffffff;">${stats.employeeFollowup.sent}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #9ca3af;">Contacts Who Replied</td>
                                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #10b981;">${stats.employeeFollowup.replied}</td>
                            </tr>
                        </table>
                        ${stats.employeeFollowup.contacts > 0 && stats.employeeFollowup.sent > 0 ? `
                        <p style="margin: 10px 0 0; font-size: 11px; color: #6b7280; line-height: 1.5;">
                            💡 ${stats.employeeFollowup.sent} emails were sent to ${stats.employeeFollowup.contacts} contacts — each contact receives multiple emails across the sequence steps.
                        </p>` : ''}
                    </div>
                </div>
                
                <!-- FOOTER -->
                <div style="background: #1f2937; padding: 24px 30px; text-align: center; border-top: 1px solid #374151;">
                    <div style="font-size: 14px; font-weight: 800; color: #ffffff; margin-bottom: 4px;">Equipo Experto</div>
                    <p style="font-size: 12px; color: #6b7280; margin: 0; line-height: 1.5;">© ${new Date().getFullYear()} Equipo Experto. All rights reserved.</p>
                    <p style="font-size: 11px; color: #4b5563; margin-top: 4px; line-height: 1.5;">This report was automatically compiled by your automated digital workspaces.</p>
                </div>
            </div>
        </body>
        </html>
    `;
};


/**
 * Generates a PDF buffer of the weekly report using PDFKit.
 * Pure JS — no browser required.
 */
export const generateReportPdf = (user, stats) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const DARK  = '#1e293b';
        const MID   = '#475569';
        const LIGHT = '#94a3b8';
        const ACCENT = '#6366f1';
        const GREEN  = '#16a34a';
        const RED    = '#dc2626';
        const AMBER  = '#d97706';
        const pageW  = doc.page.width - 80; // 40 margins each side

        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - 7);
        const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const dateStr = `${fmt(start)} – ${fmt(end)}`;

        // ── HEADER ──────────────────────────────────────────────
        doc.rect(0, 0, doc.page.width, 80).fill('#1e1b4b');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18)
           .text('Weekly Performance Report', 40, 22);
        doc.fillColor('#a5b4fc').font('Helvetica').fontSize(10)
           .text(dateStr, 40, 46);
        doc.fillColor('#a5b4fc').fontSize(9)
           .text(`${user.company_name || user.name || 'Partner'}`, 40, 60);
        doc.moveDown(3);

        // ── SECTION HELPER ──────────────────────────────────────
        const sectionTitle = (title, color = ACCENT) => {
            doc.moveDown(0.4);
            doc.fillColor(color).font('Helvetica-Bold').fontSize(8)
               .text(title.toUpperCase(), { characterSpacing: 1.2 });
            doc.moveDown(0.2);
        };

        // ── OVERVIEW ROW ────────────────────────────────────────
        sectionTitle('Overview — Last 7 Days');
        const cols = [
            { label: 'New Leads',      value: stats.newLeads,          color: '#3b82f6' },
            { label: 'Google Reviews', value: stats.reviewsCollected,   color: GREEN },
            { label: 'Avg Rating',     value: stats.avgRating > 0 ? `⭐ ${stats.avgRating}` : 'N/A', color: AMBER },
        ];
        const cw = pageW / 3;
        cols.forEach((col, i) => {
            const x = 40 + i * cw;
            const y = doc.y;
            doc.rect(x, y, cw - 6, 48).fill('#f8fafc').stroke('#e2e8f0');
            doc.fillColor(LIGHT).font('Helvetica').fontSize(7)
               .text(col.label.toUpperCase(), x + 8, y + 8, { width: cw - 20, characterSpacing: 0.8 });
            doc.fillColor(col.color).font('Helvetica-Bold').fontSize(18)
               .text(String(col.value), x + 8, y + 20, { width: cw - 20 });
        });
        doc.moveDown(3.8);

        // ── ROW TABLE HELPER ────────────────────────────────────
        const tableRow = (label, value, valueColor = DARK, isLast = false) => {
            const y = doc.y;
            doc.fillColor(MID).font('Helvetica').fontSize(9).text(label, 48, y, { width: pageW - 80 });
            doc.fillColor(valueColor).font('Helvetica-Bold').fontSize(9)
               .text(String(value), 48, y, { width: pageW, align: 'right' });
            if (!isLast) {
                doc.moveTo(48, doc.y + 2).lineTo(48 + pageW, doc.y + 2).strokeColor('#f1f5f9').stroke();
            }
            doc.moveDown(0.5);
        };

        const cardHeader = (emoji, title) => {
            const y = doc.y;
            doc.rect(40, y, pageW, 26).fill('#f8fafc');
            doc.fillColor(DARK).font('Helvetica-Bold').fontSize(10)
               .text(`${emoji}  ${title}`, 48, y + 7);
            doc.moveDown(1.4);
        };

        // ── REVIEW EMPLOYEE — QR ────────────────────────────────
        sectionTitle('Digital Employee Productivity');
        cardHeader('📱', 'Review Employee — QR Code');
        tableRow('QR Code Scans',         stats.employeeReviewsQr.scans);
        tableRow('Questions Answered',    stats.employeeReviewsQr.answers);
        tableRow('Google Reviews Left',   stats.employeeReviewsQr.reviews, GREEN, true);
        doc.moveDown(0.6);

        // ── REVIEW EMPLOYEE — UPLOAD LIST ────────────────────────
        cardHeader('📊', 'Review Employee — Upload List');
        tableRow('Questionnaires Sent',       stats.employeeReviewsList.sent);
        tableRow('Emails Bounced',            stats.employeeReviewsList.bounces,   stats.employeeReviewsList.bounces > 0 ? RED : DARK);
        tableRow('Completed Questionnaires',  stats.employeeReviewsList.answers);
        tableRow('Google Reviews Left',       stats.employeeReviewsList.reviews,   GREEN);
        tableRow('Unsatisfied Alerts Sent',   stats.employeeReviewsList.unsatisfied, stats.employeeReviewsList.unsatisfied > 0 ? AMBER : DARK, true);
        doc.moveDown(0.6);

        // ── LEAD CAPTURE ────────────────────────────────────────
        cardHeader('⚡', 'Lead Capture Employee — Form / WhatsApp');
        tableRow('Form Views',              stats.employeeLeadScoring.formViews);
        tableRow('Completed Questionnaires', stats.employeeLeadScoring.completed);
        tableRow('Abandoned',               stats.employeeLeadScoring.abandoned,   stats.employeeLeadScoring.abandoned > 0 ? AMBER : DARK);
        tableRow('High-Priority Notifications', stats.employeeLeadScoring.highPriority, stats.employeeLeadScoring.highPriority > 0 ? RED : DARK, true);
        doc.moveDown(0.6);

        // ── FOLLOW-UP ────────────────────────────────────────────
        cardHeader('✉️', 'Follow-up Employee');
        tableRow('Contacts in Sequence',      stats.employeeFollowup.contacts ?? 0);
        tableRow('Total Emails Sent',         stats.employeeFollowup.sent);
        tableRow('Replied (follow-up stopped)', stats.employeeFollowup.replied, GREEN, true);
        doc.moveDown(1);

        // ── FOOTER ───────────────────────────────────────────────
        doc.fillColor(LIGHT).font('Helvetica').fontSize(8)
           .text(
               `© ${new Date().getFullYear()} Equipo Experto · Automatically generated weekly report`,
               40, doc.page.height - 40,
               { width: pageW, align: 'center' }
           );

        doc.end();
    });
};

/**
 * Sends the Weekly Report Email with PDF attachment
 */
export const sendWeeklyReport = async (user, stats) => {
    const htmlContent = generateReportHtml(user, stats);

    // Generate PDF attachment
    let pdfBuffer = null;
    try {
        pdfBuffer = await generateReportPdf(user, stats);
    } catch (pdfErr) {
        console.error('[WeeklyReport] PDF generation failed (sending email only):', pdfErr.message);
    }

    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const pdfFilename = `weekly-report-${fmt(start).replace(' ', '-')}-${fmt(end).replace(' ', '-')}.pdf`;

    const mailOptions = {
        to: user.email,
        subject: `📈 Weekly Report: ${stats.newLeads} New Leads & ${stats.reviewsCollected} Reviews`,
        html: htmlContent,
        ...(pdfBuffer && {
            attachments: [{
                filename: pdfFilename,
                content: pdfBuffer,
                contentType: 'application/pdf',
            }],
        }),
    };

    return sendDynamicEmail(user.id, mailOptions);
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
