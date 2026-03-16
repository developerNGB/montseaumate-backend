import pool from '../db/pool.js';

/**
 * GET /api/feedback
 * Fetch all feedback for the current user
 */
export const getFeedback = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM feedback 
             WHERE user_id = $1 
             ORDER BY created_at DESC`,
            [req.user.id]
        );

        return res.status(200).json({
            success: true,
            data: result.rows
        });
    } catch (err) {
        console.error('[getFeedback] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * GET /api/feedback/stats
 * Dashboard stats for feedback
 */
export const getFeedbackStats = async (req, res) => {
    try {
        const stats = await pool.query(
            `SELECT 
                COUNT(*) as total_feedback,
                AVG(rating_overall) as avg_rating,
                COUNT(CASE WHEN contact_requested = true THEN 1 END) as leads_captured
             FROM feedback 
             WHERE user_id = $1`,
            [req.user.id]
        );

        return res.status(200).json({
            success: true,
            data: {
                total_feedback: parseInt(stats.rows[0].total_feedback) || 0,
                avg_rating: parseFloat(stats.rows[0].avg_rating) || 0,
                leads_captured: parseInt(stats.rows[0].leads_captured) || 0
            }
        });
    } catch (err) {
        console.error('[getFeedbackStats] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
