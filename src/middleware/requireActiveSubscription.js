import pool from '../db/pool.js';
import { hasDashboardAccess } from '../utils/billingAccess.js';

/**
 * Blocks dashboard API calls until the user has completed Stripe checkout
 * (stripe_subscription_id set) or is an admin.
 */
export default async function requireActiveSubscription(req, res, next) {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({
                success: false,
                code: 'auth_required',
                message: 'Access denied. No token provided.',
            });
        }

        const result = await pool.query(
            `SELECT id, email, role, plan, status, trial_ends_at, stripe_subscription_id, stripe_customer_id, onboarding_completed, created_at
             FROM users WHERE id = $1`,
            [userId]
        );
        const row = result.rows[0];
        if (!row || row.status !== 'active') {
            return res.status(403).json({
                success: false,
                code: 'account_inactive',
                message: 'Your account is not active.',
            });
        }

        if (hasDashboardAccess(row)) {
            req.user = { ...req.user, ...row };
            return next();
        }

        return res.status(403).json({
            success: false,
            code: 'subscription_required',
            message: 'Choose a plan and complete checkout to access the dashboard.',
        });
    } catch (err) {
        console.error('[requireActiveSubscription]', err.message);
        return res.status(500).json({
            success: false,
            message: 'Server error.',
        });
    }
}
