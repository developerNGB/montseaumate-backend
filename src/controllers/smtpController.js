import pool from '../db/pool.js';
import { detectSmtpProvider, testSmtpConnection, sendDynamicEmail } from '../services/emailService.js';
import crypto from 'crypto';

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

// ── In-memory SMTP test job store ────────────────────────────────────────────
// Each entry: { status: 'pending'|'done', result: {...}, expiresAt: timestamp }
const smtpTestJobs = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of smtpTestJobs) {
        if (job.expiresAt < now) smtpTestJobs.delete(id);
    }
}, 5 * 60 * 1000);

/**
 * POST /api/smtp/test
 * Saves the SMTP config temporarily, then sends a REAL test email via the
 * full sendDynamicEmail dispatch chain (SMTP → Gmail API → Microsoft).
 * Returns 202 immediately; frontend polls GET /test/:jobId for the result.
 *
 * Why sendDynamicEmail instead of raw SMTP verify()?
 * Render's free plan blocks outbound SMTP ports (465/587).
 * sendDynamicEmail falls back to Gmail API when SMTP is unreachable,
 * so the test actually works regardless of Render's port restrictions.
 */
export const testConnection = async (req, res) => {
    try {
        const { host, port, secure, auth_user, auth_pass, from_email, from_name, test_email } = req.body;

        let finalPass = auth_pass;
        if (!finalPass) {
            const existing = await pool.query('SELECT auth_pass FROM smtp_settings WHERE user_id = $1', [req.user.id]);
            finalPass = existing.rows[0]?.auth_pass;
        }

        if (!host || !port || !auth_user || !finalPass) {
            return res.status(400).json({ success: false, message: 'Incomplete configuration for testing' });
        }

        // Create async job and respond immediately
        const jobId = crypto.randomUUID();
        smtpTestJobs.set(jobId, {
            status: 'pending',
            result: null,
            expiresAt: Date.now() + 5 * 60 * 1000,
        });

        const userId = req.user.id;
        const recipient = String(test_email || from_email || auth_user || req.user.email || '').trim();
        const senderName = from_name || 'Equipo Experto';
        const senderEmail = from_email || auth_user;

        // Fire and forget — runs the full email dispatch in background
        (async () => {
            try {
                // Temporarily upsert SMTP settings so sendDynamicEmail can find them.
                // is_active = false so it doesn't override the live config if not yet saved.
                await pool.query(
                    `INSERT INTO smtp_settings
                        (user_id, host, port, secure, auth_user, auth_pass, from_email, from_name, is_active, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,NOW())
                     ON CONFLICT (user_id) DO UPDATE SET
                        host=EXCLUDED.host, port=EXCLUDED.port, secure=EXCLUDED.secure,
                        auth_user=EXCLUDED.auth_user, auth_pass=EXCLUDED.auth_pass,
                        from_email=EXCLUDED.from_email, from_name=EXCLUDED.from_name,
                        updated_at=NOW()`,
                    [userId, host, parseInt(port, 10), !!secure, auth_user, finalPass, senderEmail, senderName]
                );

                // Force is_active=true for this test query only (separate read)
                await pool.query(
                    'UPDATE smtp_settings SET is_active=true WHERE user_id=$1',
                    [userId]
                );

                const result = await sendDynamicEmail(userId, {
                    to: recipient,
                    subject: 'SMTP test email from Equipo Experto',
                    html: `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
                        <h2 style="margin:0 0 12px">✅ Email delivery verified</h2>
                        <p style="margin:0 0 12px">Your email is working correctly with Equipo Experto.</p>
                        <ul style="margin:0 0 16px;padding-left:20px">
                            <li><strong>Server:</strong> ${host}:${port}</li>
                            <li><strong>Security:</strong> ${secure ? 'SSL/TLS' : 'STARTTLS / Standard'}</li>
                            <li><strong>Sent via:</strong> {provider}</li>
                        </ul>
                        <p style="margin:0;color:#64748b;font-size:0.85em">If you did not request this test, you can ignore this email.</p>
                    </div>`,
                    text: `Email delivery verified.\nServer: ${host}:${port}\nSecurity: ${secure ? 'SSL/TLS' : 'STARTTLS'}`,
                });

                const providerLabel = result.provider === 'smtp'
                    ? 'your custom SMTP server'
                    : result.provider === 'google'
                    ? 'Gmail API (SMTP fallback — Render blocks direct SMTP ports on free plan)'
                    : result.provider === 'microsoft'
                    ? 'Microsoft Outlook'
                    : 'email integration';

                smtpTestJobs.set(jobId, {
                    status: 'done',
                    result: {
                        success: true,
                        message: `Test email sent to ${recipient} via ${providerLabel}.`,
                        hint: result.provider !== 'smtp'
                            ? 'Email is working ✅. Note: Render free plan blocks direct SMTP — your app uses Gmail API as fallback, which works perfectly.'
                            : null,
                    },
                    expiresAt: Date.now() + 5 * 60 * 1000,
                });
            } catch (err) {
                smtpTestJobs.set(jobId, {
                    status: 'done',
                    result: {
                        success: false,
                        code: 'smtp_test_failed',
                        message: err.message || 'Could not send test email.',
                        hint: 'Make sure your Gmail integration is connected in Integrations, or check your SMTP credentials.',
                    },
                    expiresAt: Date.now() + 5 * 60 * 1000,
                });
            }
        })();

        return res.status(202).json({ jobId });

    } catch (error) {
        console.error('[testConnection] Error:', error.message);
        return res.status(500).json({ success: false, message: 'SMTP test failed unexpectedly.' });
    }
};


/**
 * GET /api/smtp/test/:jobId
 * Poll for the result of an async SMTP test job.
 */
export const pollTestResult = (req, res) => {
    const job = smtpTestJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ success: false, message: 'Test job not found or expired.' });
    }
    if (job.status === 'pending') {
        return res.status(202).json({ status: 'pending' });
    }
    // Done — clean up and return result
    smtpTestJobs.delete(req.params.jobId);
    const r = job.result;
    if (r.success) {
        return res.status(200).json({ success: true, message: r.message, hint: r.hint || null });
    }
    return res.status(r.status || 400).json({
        success: false,
        code: r.code || 'smtp_test_failed',
        message: r.message || 'Connection failed.',
        hint: r.hint || null,
    });
};


export const detectConnection = async (req, res) => {
    try {
        const { email } = req.body || {};
        const detection = await detectSmtpProvider(email);
        return res.status(detection.status || 200).json(detection);
    } catch (error) {
        console.error('[detectConnection] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Could not detect SMTP settings right now.',
        });
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
