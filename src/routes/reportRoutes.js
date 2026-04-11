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
        
        // Fetch user details
        const userRes = await pool.query(
            "SELECT id, name, company_name, email FROM users WHERE id = $1",
            [userId]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const user = userRes.rows[0];
        const stats = await getWeeklyStats(user.id);

        await sendWeeklyReport(user, stats);

        return res.status(200).json({
            success: true,
            message: 'Weekly report sent successfully'
        });
    } catch (err) {
        console.error('[ManualReportTrigger] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to send manual report' });
    }
});

export default router;
