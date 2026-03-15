import pool from '../db/pool.js';

// GET /api/activity-logs
export const getActivityLogs = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, automation_name, trigger_type, status, detail, metadata, created_at
             FROM activity_logs
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 100`,
            [req.user.id]
        );

        return res.status(200).json({ success: true, logs: result.rows });
    } catch (err) {
        console.error('[getActivityLogs] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
