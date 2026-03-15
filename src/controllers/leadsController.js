import pool from '../db/pool.js';

export const getLeads = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, full_name, email, phone, message, source, created_at, followup_status
             FROM leads
             WHERE user_id = $1
             ORDER BY created_at DESC`,
            [req.user.id]
        );

        return res.status(200).json({ success: true, leads: result.rows });
    } catch (err) {
        console.error('[getLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
