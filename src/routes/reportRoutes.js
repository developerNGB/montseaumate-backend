import express from 'express';
import authenticateToken from '../middleware/authenticate.js';
import { getWeeklyStats, generateReportPDF, sendWeeklyReport } from '../services/reportService.js';
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

        console.log(`[ReportDownload] Generating PDF with Puppeteer...`);
        const pdfBuffer = await generateReportPDF(user, stats);
        console.log(`[ReportDownload] PDF generated, size: ${pdfBuffer.length} bytes`);

        console.log(`[ReportDownload] Triggering test email dispatch alongside download...`);
        sendWeeklyReport(user, stats).catch(err => {
            console.error(`[ReportDownload] Background email failed to send:`, err.message);
        });

        console.log(`[ReportDownload] Success! Sending PDF to ${user.email}, output size: ${pdfBuffer.length} bytes`);

        // Use standard Express .send() to handle Binary chunk encoding and Content-Length seamlessly natively.
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="Weekly_Report_${new Date().toISOString().split('T')[0]}.pdf"`
        });
        
        return res.status(200).send(pdfBuffer);

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
