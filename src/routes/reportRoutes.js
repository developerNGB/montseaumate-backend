import express from 'express';
import authenticateToken from '../middleware/authenticate.js';
import { getWeeklyStats, sendWeeklyReport } from '../services/reportService.js';
import pool from '../db/pool.js';

const router = express.Router();

/**
 * POST /api/reports/trigger
 * Manually triggers a weekly report email for the current user.
 */
router.post('/trigger', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        console.log(`[ManualReportTrigger] Starting for user: ${userId}`);
        
        // Fetch user details
        const userRes = await pool.query(
            "SELECT id, name, company_name, email FROM users WHERE id = $1",
            [userId]
        );

        if (userRes.rows.length === 0) {
            console.error(`[ManualReportTrigger] User ${userId} not found in database`);
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const user = userRes.rows[0];
        console.log(`[ManualReportTrigger] Generating stats for: ${user.email}`);
        const stats = await getWeeklyStats(user.id);

        console.log(`[ManualReportTrigger] Sending email...`);
        await sendWeeklyReport(user, stats);

        console.log(`[ManualReportTrigger] Success! Report sent to ${user.email}`);
        return res.status(200).json({
            success: true,
            message: 'Weekly report sent successfully'
        });
    } catch (err) {
        console.error('[ManualReportTrigger] FATAL ERROR:', err.message);
        console.error(err.stack);
        return res.status(500).json({ 
            success: false, 
            message: 'Failed to send manual report',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined 
        });
    }
});

export default router;
