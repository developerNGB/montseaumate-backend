import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import pool from '../db/pool.js';
import { setJwtCookie, clearJwtCookie } from '../utils/cookieHelpers.js';

// Create OAuth client lazily to ensure env vars are loaded
const getGoogleClient = () => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        throw new Error('GOOGLE_CLIENT_ID not configured');
    }
    return new OAuth2Client(clientId);
};

const SALT_ROUNDS = 10; // Optimized for performance while maintaining high security

/**
 * Generate a signed JWT for a given user payload.
 */
const signToken = (user) => {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: user.role,
            plan: user.plan,
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );
};

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

/**
 * Validates if the email is a professional Gmail account
 */
const isGmail = (email) => {
    const gmailRegex = /^[a-z0-9](\.?[a-z0-9]){5,}@(gmail\.com|googlemail\.com)$/i;
    return gmailRegex.test(email.toLowerCase().trim());
};

/**
 * POST /auth/request-otp
 * Body: { email }
 */
export const requestOTP = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || !isGmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'A valid Gmail address is required to create a professional account.'
            });
        }

        const emailLower = email.toLowerCase().trim();

        // Check if user already exists
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [emailLower]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'An account with this Gmail already exists.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await pool.query(
            'INSERT INTO otp_verifications (email, otp_code, expires_at) VALUES ($1, $2, $3)',
            [emailLower, otp, expiresAt]
        );

        const mailOptions = {
            from: `"Growth Engine Support" <${process.env.EMAIL_USER}>`,
            to: emailLower,
            subject: 'Verify your Gmail - Growth Engine',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                    <h2 style="color: #4f46e5; text-align: center;">Welcome to Growth Engine</h2>
                    <p>To ensure you follow the professional standard, please use the following verification code to complete your registration:</p>
                    <div style="background: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
                        <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #111827;">${otp}</span>
                    </div>
                    <p style="color: #6b7280; font-size: 14px;">This code will expire in 10 minutes. If you did not request this, please ignore this email.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);

        return res.status(200).json({
            success: true,
            message: 'Verification code sent to your Gmail.'
        });
    } catch (err) {
        console.error('[requestOTP] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to send verification email. Please ensure your email settings are correct.' });
    }
};

/**
 * POST /auth/register
 * Body: { name, email, password, company_name, otp }
 */
export const register = async (req, res) => {
    try {
        const { name, email, password, company_name, otp } = req.body;

        if (!name || !email || !password || !company_name || !otp) {
            return res.status(400).json({ success: false, message: 'All fields including the verification code are required.' });
        }

        const emailLower = email.toLowerCase().trim();

        // Verify OTP
        const otpResult = await pool.query(
            'SELECT id FROM otp_verifications WHERE email = $1 AND otp_code = $2 AND expires_at > NOW()',
            [emailLower, otp]
        );

        if (otpResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification code.' });
        }

        // Check if email already registered (race condition check)
        const checkDupe = await pool.query('SELECT id FROM users WHERE email = $1', [emailLower]);
        if (checkDupe.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'Account already exists.' });
        }

        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

        const result = await pool.query(
            `INSERT INTO users (name, email, password_hash, company_name)
             VALUES ($1, $2, $3, $4)
             RETURNING id, name, email, company_name, plan, role, created_at, weekly_reports_enabled`,
            [name.trim(), emailLower, password_hash, company_name.trim()]
        );

        const newUser = result.rows[0];

        // ── Default Gmail Integration ────────────────
        // By default, every user has their Gmail integrated. 
        // We use the system fallback until they connect their own professional OAuth2 tokens.
        await pool.query(
            `INSERT INTO integrations (user_id, provider, account_id, metadata, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (user_id, provider) DO NOTHING`,
            [newUser.id, 'google', newUser.email, JSON.stringify({ email: newUser.email, is_default: true })]
        );

        // Cleanup used OTP
        await pool.query('DELETE FROM otp_verifications WHERE email = $1', [emailLower]);

        await pool.query(
            'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
            [newUser.id, password_hash]
        );

        const token = signToken(newUser);
        
        // Set HttpOnly cookie (new secure way)
        setJwtCookie(res, token);

        return res.status(201).json({
            success: true,
            message: 'Account verified and created successfully.',
            token, // Keep for backward compatibility during transition
            user: newUser,
        });
    } catch (err) {
        console.error('[register] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
};

/**
 * POST /auth/login
 * Body: { email, password }
 */
export const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        // ── Validation ──────────────────────────────
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required.',
            });
        }

        // ── Fetch user ───────────────────────────────
        let result;
        try {
            result = await pool.query(
                `SELECT id, name, email, password_hash, company_name, phone, plan, role, status, created_at, weekly_reports_enabled
                 FROM users WHERE email = $1`,
                [email.toLowerCase().trim()]
            );
        } catch (e) {
            if (e.code !== '42703') throw e; // undefined_column — column not yet migrated
            result = await pool.query(
                `SELECT id, name, email, password_hash, company_name, phone, plan, role, status, created_at
                 FROM users WHERE email = $1`,
                [email.toLowerCase().trim()]
            );
            result.rows = result.rows.map(r => ({ ...r, weekly_reports_enabled: true }));
        }

        if (result.rows.length === 0) {
            // Generic message — don't reveal whether email exists
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password.',
            });
        }

        const user = result.rows[0];

        // ── Check account status ─────────────────────
        if (user.status !== 'active') {
            return res.status(403).json({
                success: false,
                message: 'Your account has been deactivated. Please contact support.',
            });
        }

        // ── Verify password ──────────────────────────
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password.',
            });
        }

        const token = signToken(user);

        // Strip sensitive fields before responding
        const { password_hash: _, ...safeUser } = user;
        
        // Set HttpOnly cookie (new secure way)
        setJwtCookie(res, token);

        return res.status(200).json({
            success: true,
            message: 'Login successful.',
            token, // Keep for backward compatibility during transition
            user: safeUser,
        });
    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

/**
 * GET /auth/profile
 * Requires: Bearer token in Authorization header
 */
export const getProfile = async (req, res) => {
    try {
        console.log('[getProfile] Fetching for user id:', req.user?.id);
        const result = await pool.query(
            `SELECT id, name, email, company_name, phone, plan, role, status, created_at, weekly_reports_enabled, onboarding_completed
             FROM users
             WHERE id = $1`,
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User account no longer exists.',
            });
        }

        return res.status(200).json({
            success: true,
            user: result.rows[0],
        });
    } catch (err) {
        console.error('[getProfile] CRITICAL:', err.message, err.stack);
        return res.status(500).json({
            success: false,
            message: `Server sync error: ${err.message}`,
            hint: 'This usually means a database column is missing or unreachable.'
        });
    }
};

/**
 * PUT /auth/profile
 * Body: { company_name, email, phone }
 */
export const updateProfile = async (req, res) => {
    try {
        const { company_name, email, phone, weekly_reports_enabled, onboarding_completed } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required.' });
        }

        // Check if new email is taken by another user
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 AND id != $2',
            [email.toLowerCase().trim(), req.user.id]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'Email address is already in use.' });
        }

        const result = await pool.query(
            `UPDATE users
             SET company_name = $1, email = $2, phone = $3, weekly_reports_enabled = $4, onboarding_completed = COALESCE($5, onboarding_completed), updated_at = NOW()
             WHERE id = $6
             RETURNING id, name, email, company_name, phone, plan, role, status, created_at, weekly_reports_enabled, onboarding_completed`,
            [
                company_name ? company_name.trim() : null,
                email.toLowerCase().trim(),
                phone ? phone.trim() : null,
                weekly_reports_enabled !== undefined ? weekly_reports_enabled : true,
                onboarding_completed !== undefined ? onboarding_completed : null,
                req.user.id
            ]
        );

        return res.status(200).json({
            success: true,
            message: 'Profile updated successfully.',
            user: result.rows[0],
        });
    } catch (err) {
        console.error('[updateProfile] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Server error. Please try again later.',
        });
    }
};

/**
 * PUT /auth/password
 * Body: { currentPassword, newPassword }
 */
export const updatePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Current and new passwords are required.' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long.' });
        }

        // Fetch current password hash
        const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);

        const isMatch = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Incorrect current password.' });
        }

        // Check password history
        const history = await pool.query('SELECT password_hash FROM password_history WHERE user_id = $1', [req.user.id]);
        for (const row of history.rows) {
            const isUsedMatch = await bcrypt.compare(newPassword, row.password_hash);
            if (isUsedMatch) {
                return res.status(400).json({ success: false, message: 'You cannot use a previously used password.' });
            }
        }

        const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

        await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [password_hash, req.user.id]);

        // Add to history
        await pool.query(
            'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
            [req.user.id, password_hash]
        );

        return res.status(200).json({
            success: true,
            message: 'Password changed successfully.',
        });
    } catch (err) {
        console.error('[updatePassword] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Server error. Please try again later.',
        });
    }
};

/**
 * POST /auth/forgot-password
 * Body: { email }
 */
export const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required.' });
        }

        const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email.toLowerCase().trim()]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'gmail not found' });
        }

        const user = result.rows[0];

        // Generate a short-lived token (5 mins) for immediate reset
        const resetToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        await pool.query(
            'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, tokenHash, expiresAt]
        );

        const resetLink = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

        const mailOptions = {
            from: `"Growth Engine Support" <${process.env.EMAIL_USER}>`,
            to: email.toLowerCase().trim(),
            subject: 'Reset your password - Growth Engine',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px;">
                    <h2 style="color: #4f46e5; text-align: center;">Password Reset Request</h2>
                    <p>Hello ${user.name},</p>
                    <p>We received a request to reset your password. Click the professional secure link below to proceed:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetLink}" style="background: #4f46e5; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset Password</a>
                    </div>
                    <p style="color: #6b7280; font-size: 14px;">This link will expire in 5 minutes. If you did not request this, please ignore this email.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);

        return res.status(200).json({
            success: true,
            message: 'A professional reset link has been sent to your Gmail.'
        });
    } catch (err) {
        console.error('[forgotPassword] Error:', err);
        return res.status(500).json({ success: false, message: 'Failed to send reset email. Please try again later.' });
    }
};

/**
 * POST /auth/reset-password
 * Body: { token, newPassword }
 */
export const resetPassword = async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ success: false, message: 'Token and new password are required.' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long.' });
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        // Find token
        const result = await pool.query(
            'SELECT id, user_id, expires_at, used FROM password_resets WHERE token_hash = $1',
            [tokenHash]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired token.' });
        }

        const resetRecord = result.rows[0];

        if (resetRecord.used) {
            return res.status(400).json({ success: false, message: 'This reset token has already been used.' });
        }

        if (new Date() > new Date(resetRecord.expires_at)) {
            return res.status(400).json({ success: false, message: 'This reset token has expired.' });
        }

        const userId = resetRecord.user_id;

        // Check password history
        const history = await pool.query('SELECT password_hash FROM password_history WHERE user_id = $1', [userId]);
        for (const row of history.rows) {
            const isUsedMatch = await bcrypt.compare(newPassword, row.password_hash);
            if (isUsedMatch) {
                return res.status(400).json({ success: false, message: 'You cannot use a previously used password.' });
            }
        }

        // Hash new password and update
        const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

        await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [password_hash, userId]);

        // Add to history
        await pool.query(
            'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
            [userId, password_hash]
        );

        // Mark token as used
        await pool.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [resetRecord.id]);

        return res.status(200).json({ success: true, message: 'Password has been successfully updated.' });
    } catch (err) {
        console.error('[resetPassword] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Server error. Please try again later.',
        });
    }
};

/**
 * GET /auth/verify-reset-token/:token
 */
export const verifyResetToken = async (req, res) => {
    try {
        const { token } = req.params;
        if (!token) {
            return res.status(400).json({ success: false, message: 'Token is required.' });
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const result = await pool.query(
            'SELECT expires_at, used FROM password_resets WHERE token_hash = $1',
            [tokenHash]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired token.' });
        }

        const resetRecord = result.rows[0];

        if (resetRecord.used) {
            return res.status(400).json({ success: false, message: 'This reset token has already been used.' });
        }

        if (new Date() > new Date(resetRecord.expires_at)) {
            return res.status(400).json({ success: false, message: 'This reset token has expired.' });
        }

        return res.status(200).json({ success: true, message: 'Token is valid.' });
    } catch (err) {
        console.error('[verifyResetToken] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

/**
 * POST /auth/google
 * Body: { access_token } — OAuth2 access token from useGoogleLogin hook
 * Verifies via Google's userinfo API (no client ID dependency on the server).
 */
export const googleLogin = async (req, res) => {
    try {
        const { access_token } = req.body;

        if (!access_token) {
            return res.status(400).json({ success: false, message: 'Google access token is required.' });
        }

        // Fetch user info from Google
        let googleUser;
        try {
            const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${access_token}` },
            });
            if (!userInfoRes.ok) {
                throw new Error(`Google API returned ${userInfoRes.status}`);
            }
            googleUser = await userInfoRes.json();
        } catch (fetchErr) {
            console.error('[googleLogin] Google userinfo fetch failed:', fetchErr.message);
            return res.status(401).json({ success: false, message: 'Google token is invalid or expired. Please try signing in again.' });
        }

        if (!googleUser.email || !googleUser.verified_email) {
            return res.status(401).json({ success: false, message: 'Google account email is not verified.' });
        }

        const emailLower = googleUser.email.toLowerCase().trim();
        const name = googleUser.name || emailLower.split('@')[0];

        // Atomic upsert: insert if new, do nothing if email already exists, then fetch
        // ON CONFLICT prevents race-condition failures when two requests arrive simultaneously
        const upsertResult = await pool.query(
            `INSERT INTO users (name, email, password_hash, company_name)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (email) DO NOTHING
             RETURNING id`,
            [name, emailLower, '', '']
        );

        const isNewUser = upsertResult.rows.length > 0;

        // Now fetch the full user row (always present after upsert)
        let result;
        try {
            result = await pool.query(
                `SELECT id, name, email, company_name, phone, plan, role, status,
                        COALESCE(weekly_reports_enabled, TRUE) AS weekly_reports_enabled
                 FROM users WHERE email = $1`,
                [emailLower]
            );
        } catch (e) {
            if (e.code !== '42703') throw e; // undefined_column — column not yet migrated
            result = await pool.query(
                `SELECT id, name, email, company_name, phone, plan, role, status
                 FROM users WHERE email = $1`,
                [emailLower]
            );
            result.rows = result.rows.map(r => ({ ...r, weekly_reports_enabled: true }));
        }

        if (result.rows.length === 0) {
            console.error('[googleLogin] User not found after upsert:', emailLower);
            return res.status(500).json({ success: false, message: 'Failed to retrieve account. Please try again.' });
        }

        const user = result.rows[0];

        if (user.status !== 'active') {
            return res.status(403).json({ success: false, message: 'Your account is deactivated. Please contact support.' });
        }

        const token = signToken(user);
        setJwtCookie(res, token);

        return res.status(200).json({
            success: true,
            message: 'Google sign-in successful.',
            token,
            user,
            isNewUser,
        });
    } catch (err) {
        console.error('[googleLogin] Unexpected error:', err.message, err.code, err.stack?.split('\n').slice(0, 4).join(' | '));
        return res.status(500).json({
            success: false,
            message: 'An unexpected error occurred during Google sign-in. Please try again.',
        });
    }
};

/**
 * PUT /auth/plan
 * Body: { plan }
 */
export const updatePlan = async (req, res) => {
    try {
        const { plan } = req.body;
        const validPlans = ['free', 'Growth', 'Pro'];
        
        if (!plan || !validPlans.includes(plan)) {
            return res.status(400).json({ success: false, message: 'Invalid plan selected.' });
        }

        const result = await pool.query(
            `UPDATE users SET plan = $1, updated_at = NOW() 
             WHERE id = $2 
             RETURNING id, name, email, company_name, phone, plan, role, status, weekly_reports_enabled`,
            [plan, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        const updatedUser = result.rows[0];
        const token = signToken(updatedUser);
        setJwtCookie(res, token);

        return res.status(200).json({
            success: true,
            message: `Plan upgraded to ${plan} successfully!`,
            user: updatedUser,
            token
        });
    } catch (err) {
        console.error('[updatePlan] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error. Please try again later.' });
    }
};

/**
 * DELETE /auth/account
 * Permanently deletes the authenticated user and all their data.
 */
export const deleteAccount = async (req, res) => {
    try {
        const userId = req.user.id;

        // Delete in dependency order to satisfy foreign key constraints
        await pool.query('DELETE FROM activity_logs WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM leads WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM feedback WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM integrations WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM review_funnel_settings WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM lead_followup_settings WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM smtp_settings WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM password_history WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM otp_verifications WHERE email = (SELECT email FROM users WHERE id = $1)', [userId]);

        // Finally delete the user
        const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Account not found.' });
        }

        clearJwtCookie(res);

        return res.status(200).json({ success: true, message: 'Account permanently deleted.' });
    } catch (err) {
        console.error('[deleteAccount] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete account. Please try again.' });
    }
};

