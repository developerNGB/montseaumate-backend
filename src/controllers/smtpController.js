import pool from '../db/pool.js';
import { testSmtpConnection } from '../services/emailService.js';

/**
 * GET /api/smtp
 * Fetches current SMTP settings for the user
 */
export const getSmtpSettings = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT host, port, secure, auth_user, from_email, from_name, is_active FROM smtp_settings WHERE user_id = $1',
            [req.user.id]
        );

        return res.status(200).json({
            success: true,
            settings: result.rows[0] || null
        });
    } catch (error) {
        console.error('[getSmtpSettings] Error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch SMTP settings' });
    }
};

/**
 * POST /api/smtp
 * Saves or updates SMTP settings
 */
export const saveSmtpSettings = async (req, res) => {
    try {
        const { host, port, secure, auth_user, auth_pass, from_email, from_name, is_active } = req.body;

        if (!host || !port || !auth_user || !from_email) {
            return res.status(400).json({ success: false, message: 'Missing required configuration fields' });
        }

        // 1. Try to fetch existing settings to see if we should keep the same password if not provided
        const existing = await pool.query('SELECT auth_pass FROM smtp_settings WHERE user_id = $1', [req.user.id]);
        const finalPass = auth_pass || (existing.rows[0] ? existing.rows[0].auth_pass : null);

        if (!finalPass) {
            return res.status(400).json({ success: false, message: 'SMTP password is required' });
        }

        // 2. Upsert
        const result = await pool.query(
            `INSERT INTO smtp_settings (user_id, host, port, secure, auth_user, auth_pass, from_email, from_name, is_active, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
             ON CONFLICT (user_id) 
             DO UPDATE SET 
                host = EXCLUDED.host,
                port = EXCLUDED.port,
                secure = EXCLUDED.secure,
                auth_user = EXCLUDED.auth_user,
                auth_pass = EXCLUDED.auth_pass,
                from_email = EXCLUDED.from_email,
                from_name = EXCLUDED.from_name,
                is_active = EXCLUDED.is_active,
                updated_at = NOW()
             RETURNING *`,
            [req.user.id, host, parseInt(port), !!secure, auth_user, finalPass, from_email, from_name || null, !!is_active]
        );

        return res.status(200).json({
            success: true,
            message: 'SMTP settings saved successfully',
            settings: { ...result.rows[0], auth_pass: undefined } // Don't return password
        });

    } catch (error) {
        console.error('[saveSmtpSettings] Error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to save SMTP settings' });
    }
};

/**
 * POST /api/smtp/test
 * Tests the provided SMTP configuration immediately
 */
export const testConnection = async (req, res) => {
    try {
        const { host, port, secure, auth_user, auth_pass } = req.body;
        
        // If password is not provided, try to get from DB
        let finalPass = auth_pass;
        if (!finalPass) {
             const existing = await pool.query('SELECT auth_pass FROM smtp_settings WHERE user_id = $1', [req.user.id]);
             finalPass = existing.rows[0]?.auth_pass;
        }

        if (!host || !port || !auth_user || !finalPass) {
            return res.status(400).json({ success: false, message: 'Incomplete configuration for testing' });
        }

        const testResult = await testSmtpConnection({ host, port: parseInt(port), secure, auth_user, auth_pass: finalPass });

        if (testResult.success) {
            return res.status(200).json({ success: true, message: 'SMTP Connection Successful!' });
        } else {
            return res.status(400).json({ success: false, message: 'Connection failed', error: testResult.error });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Test interrupted', error: error.message });
    }
};

/**
 * DELETE /api/smtp
 * Deletes user's custom SMTP configuration
 */
export const deleteSmtpSettings = async (req, res) => {
    try {
        await pool.query('DELETE FROM smtp_settings WHERE user_id = $1', [req.user.id]);
        return res.status(200).json({ success: true, message: 'SMTP settings removed' });
    } catch (error) {
        console.error('[deleteSmtpSettings] Error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to remove settings' });
    }
};
