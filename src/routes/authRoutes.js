import { Router } from 'express';
import { register, login, getProfile, updateProfile, updatePassword, forgotPassword, resetPassword, verifyResetToken, requestOTP, googleLogin, deleteAccount, updatePlan } from '../controllers/authController.js';
import authenticate from '../middleware/authenticate.js';
import { clearJwtCookie } from '../utils/cookieHelpers.js';

const router = Router();

// POST /auth/request-otp — Step 1: Request Gmail verification code
router.post('/request-otp', requestOTP);

// POST /auth/register — Step 2: Create account with OTP
router.post('/register', register);

// POST /auth/login — authenticate and receive a JWT
router.post('/login', login);

// GET /auth/profile — get the logged-in user's profile (protected)
router.get('/profile', authenticate, getProfile);

// PUT /auth/profile — update profile data (protected)
router.put('/profile', authenticate, updateProfile);

// PUT /auth/plan — update user plan (protected)
router.put('/plan', authenticate, updatePlan);

// PUT /auth/password — update password (protected)
router.put('/password', authenticate, updatePassword);

// POST /auth/forgot-password — request a reset token
router.post('/forgot-password', forgotPassword);

// POST /auth/reset-password — reset password using token
router.post('/reset-password', resetPassword);

// GET /auth/verify-reset-token/:token — check if token is valid
router.get('/verify-reset-token/:token', verifyResetToken);

// POST /auth/google — Sign in / sign up with Google
router.post('/google', googleLogin);

// DELETE /auth/account — permanently delete user account and all data
router.delete('/account', authenticate, deleteAccount);

// POST /auth/logout — Clear JWT cookie
router.post('/logout', authenticate, (req, res) => {
    clearJwtCookie(res);
    res.json({ success: true, message: 'Logged out successfully.' });
});

export default router;
