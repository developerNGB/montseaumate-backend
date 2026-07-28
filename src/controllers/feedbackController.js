import pool from '../db/pool.js';
import { generateFeedbackReplyDraft } from '../utils/feedbackReplyDrafts.js';
import { sendGmailEmail } from '../services/adminMailService.js';

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
                COUNT(CASE WHEN contact_requested = true THEN 1 END) as leads_captured,
                COUNT(CASE WHEN rating_overall = 1 THEN 1 END) as rating_1,
                COUNT(CASE WHEN rating_overall = 2 THEN 1 END) as rating_2,
                COUNT(CASE WHEN rating_overall = 3 THEN 1 END) as rating_3,
                COUNT(CASE WHEN rating_overall = 4 THEN 1 END) as rating_4,
                COUNT(CASE WHEN rating_overall = 5 THEN 1 END) as rating_5
             FROM feedback 
             WHERE user_id = $1`,
            [req.user.id]
        );

        return res.status(200).json({
            success: true,
            data: {
                total_feedback: parseInt(stats.rows[0].total_feedback) || 0,
                avg_rating: parseFloat(stats.rows[0].avg_rating) || 0,
                leads_captured: parseInt(stats.rows[0].leads_captured) || 0,
                rating_1: parseInt(stats.rows[0].rating_1) || 0,
                rating_2: parseInt(stats.rows[0].rating_2) || 0,
                rating_3: parseInt(stats.rows[0].rating_3) || 0,
                rating_4: parseInt(stats.rows[0].rating_4) || 0,
                rating_5: parseInt(stats.rows[0].rating_5) || 0,
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

/**
 * POST /api/feedback/:id/reply
 * Send the reply to feedback via Gmail/SMTP connection.
 */
export const replyToFeedback = async (req, res) => {
    try {
        const { id } = req.params;
        const { message } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, message: 'Message content is required.' });
        }

        const result = await pool.query(
            `SELECT f.*, u.email as owner_email, COALESCE(u.company_name, u.name) as business_name
             FROM feedback f
             JOIN users u ON u.id = f.user_id
             WHERE f.id = $1 AND f.user_id = $2`,
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Feedback not found.' });
        }

        const feedbackItem = result.rows[0];
        if (!feedbackItem.customer_email) {
            return res.status(400).json({ success: false, message: 'Customer has no email address associated.' });
        }

        await sendGmailEmail({
            to: feedbackItem.customer_email,
            subject: `Re: Your feedback to ${feedbackItem.business_name}`,
            text: message,
            replyTo: feedbackItem.owner_email
        });

        await pool.query(
            `INSERT INTO activity_logs (user_id, trigger_type, status, detail, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                req.user.id,
                'Email Reply',
                'Success',
                `Sent reply to feedback from ${feedbackItem.customer_name || 'Anonymous'} (${feedbackItem.customer_email})`,
                JSON.stringify({ feedback_id: id })
            ]
        );

        return res.status(200).json({ success: true, message: 'Reply sent successfully.' });
    } catch (err) {
        console.error('[replyToFeedback] Error:', err.message);
        return res.status(500).json({ success: false, message: err.message || 'Failed to send reply.' });
    }
};
