import express from 'express';
import authenticateToken from '../middleware/authenticate.js';
import { getWeeklyStats, generateReportHtml, sendWeeklyReport } from '../services/reportService.js';
import pool from '../db/pool.js';

const router = express.Router();

/**
 * POST /api/reports/trigger
 * Generates and downloads a weekly report PDF file for the current user.
 */
router.post('/trigger', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        console.log(`[ReportDownload] Starting for user: ${userId}`);

        // Fetch user details
        const userRes = await pool.query(
            "SELECT id, name, company_name, email FROM users WHERE id = $1",
            [userId]
        );

        if (userRes.rows.length === 0) {
            console.error(`[ReportDownload] User ${userId} not found in database`);
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const user = userRes.rows[0];
        console.log(`[ReportDownload] Generating stats for: ${user.email}`);
        const stats = await getWeeklyStats(user.id);

        console.log(`[ReportDownload] Returning JSON data for client-side PDF generation...`);
        
        // Generate date range string
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

        return res.json({
            success: true,
            reportData: {
                dateStr,
                userName: user.name || user.company_name || 'Partner',
                companyName: user.company_name || 'Equipo Experto',
                stats
            }
        });

    } catch (err) {
        console.error('[ReportDownload] FATAL ERROR:', err.message);
        console.error(err.stack);
        return res.status(500).json({
            success: false,
            message: 'Failed to generate report',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});


export default router;
