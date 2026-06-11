import pool from '../db/pool.js';
import { generateFeedbackReplyDraft } from '../utils/feedbackReplyDrafts.js';

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

/**
 * GET /api/feedback/:id/draft-reply?lang=en|es
 * Template-based "smart reply" draft for a piece of feedback — no external AI required.
 */
export const draftFeedbackReply = async (req, res) => {
    try {
        const { id } = req.params;
        const language = req.query.lang === 'es' ? 'es' : 'en';

        const result = await pool.query(
            `SELECT f.rating_overall, f.comment, f.customer_name, u.company_name
             FROM feedback f
             JOIN users u ON u.id = f.user_id
             WHERE f.id = $1 AND f.user_id = $2`,
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Feedback not found' });
        }

        const row = result.rows[0];
        const draft = generateFeedbackReplyDraft(row, {
            language,
            companyName: row.company_name,
        });

        return res.status(200).json({ success: true, draft });
    } catch (err) {
        console.error('[draftFeedbackReply] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
