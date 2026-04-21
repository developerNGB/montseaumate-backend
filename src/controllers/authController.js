import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import pool from '../db/pool.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
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

        // Cleanup used OTP
        await pool.query('DELETE FROM otp_verifications WHERE email = $1', [emailLower]);

        await pool.query(
            'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
            [newUser.id, password_hash]
        );

        const token = signToken(newUser);

        return res.status(201).json({
            success: true,
            message: 'Account verified and created successfully.',
            token,
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
        const result = await pool.query(
            `SELECT id, name, email, password_hash, company_name, phone, plan, role, status, created_at, weekly_reports_enabled
             FROM users
             WHERE email = $1`,
            [email.toLowerCase().trim()]
        );

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

        return res.status(200).json({
            success: true,
            message: 'Login successful.',
            token,
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
            `SELECT id, name, email, company_name, phone, plan, role, status, created_at, weekly_reports_enabled
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
        const { company_name, email, phone, weekly_reports_enabled } = req.body;

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
             SET company_name = $1, email = $2, phone = $3, weekly_reports_enabled = $4, updated_at = NOW()
             WHERE id = $5
             RETURNING id, name, email, company_name, phone, plan, role, status, created_at, weekly_reports_enabled`,
            [
                company_name ? company_name.trim() : null,
                email.toLowerCase().trim(),
                phone ? phone.trim() : null,
                weekly_reports_enabled !== undefined ? weekly_reports_enabled : true,
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
 * Body: { credential } — Google ID token from @react-oauth/google
 * Finds or creates a user via their verified Google account.
 */
export const googleLogin = async (req, res) => {
    try {
        const { credential } = req.body;

        if (!credential) {
            return res.status(400).json({ success: false, message: 'Google credential is required.' });
        }

        // Validate GOOGLE_CLIENT_ID is set
        if (!process.env.GOOGLE_CLIENT_ID) {
            console.error('[googleLogin] GOOGLE_CLIENT_ID is not set in environment variables');
            return res.status(500).json({ 
                success: false, 
                message: 'Server configuration error: Google Client ID not configured.' 
            });
        }

        console.log('[googleLogin] Verifying token with Client ID:', process.env.GOOGLE_CLIENT_ID.substring(0, 20) + '...');

        // Verify the ID token server-side using google-auth-library
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        
        console.log('[googleLogin] Token verified successfully');
        const payload = ticket.getPayload();

        if (!payload || !payload.email_verified) {
            return res.status(401).json({ success: false, message: 'Google account email is not verified.' });
        }

        const emailLower = payload.email.toLowerCase().trim();
        const name = payload.name || emailLower.split('@')[0];

        // Find existing user
        let result = await pool.query(
            `SELECT id, name, email, company_name, phone, plan, role, status, weekly_reports_enabled FROM users WHERE email = $1`,
            [emailLower]
        );

        let user;
        if (result.rows.length > 0) {
            user = result.rows[0];
            if (user.status !== 'active') {
                return res.status(403).json({ success: false, message: 'Your account is deactivated. Please contact support.' });
            }
        } else {
            // Auto-create account for new Google users (no password needed)
            const insertResult = await pool.query(
                `INSERT INTO users (name, email, password_hash, company_name)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, name, email, company_name, phone, plan, role, status, created_at, weekly_reports_enabled`,
                [name, emailLower, '', '']
            );
            user = insertResult.rows[0];
        }

        const token = signToken(user);

        return res.status(200).json({
            success: true,
            message: 'Google sign-in successful.',
            token,
            user,
        });
    } catch (err) {
        console.error('[googleLogin] Full Error:', err);
        return res.status(500).json({ 
            success: false, 
            message: 'Google sign-in failed.',
            error: err.message 
        });
    }
};


