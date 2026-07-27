import { isAdminUser, isNormalUser } from './adminAccess.js';
import { resolveBillingForEntitlements } from '../services/subscriptionPlans.js';

/** Account older than signup checkout funnel (not a brand-new registration). */
export function isEstablishedAccount(user) {
    if (!user?.id) return false;
    if (String(user.stripe_subscription_id || '').trim()) return true;
    if (String(user.stripe_customer_id || '').trim()) return true;
    if (user.onboarding_completed === true) return true;

    const created = user.created_at ? new Date(user.created_at) : null;
    if (created && !Number.isNaN(created.getTime())) {
        const ageMs = Date.now() - created.getTime();
        if (ageMs > 15 * 60 * 1000) return true;
    }
    return false;
}

export function isStripeConfigured() {
    return !!(
        process.env.STRIPE_SECRET_KEY &&
        process.env.STRIPE_PRICE_STARTER &&
        process.env.STRIPE_PRICE_GROWTH &&
        process.env.STRIPE_PRICE_PRO
    );
}

/**
 * Dashboard access for app + API: admin, active Stripe sub, or existing account (sign-in).
 * Brand-new sign-ups stay false until checkout (see enrichUserForNewSignup).
 */
export function hasDashboardAccess(user) {
    if (!user) return false;
    if (!isStripeConfigured()) return true;
    if (isAdminUser(user)) return true;
    if (isNormalUser(user)) return true;
    if (String(user.stripe_subscription_id || '').trim()) return true;
    if (isEstablishedAccount(user)) return true;
    return false;
}

/** Strict gate right after register / Google sign-up (before Stripe checkout). */
export function hasDashboardAccessForNewSignup(user) {
    if (!user) return false;
    if (!isStripeConfigured()) return true;
    if (isAdminUser(user)) return true;
    if (isNormalUser(user)) return true;
    return !!String(user.stripe_subscription_id || '').trim();
}

/** Client-facing user object with admin + billing flags (normal session). */
export function enrichUserForClient(user) {
    if (!user || typeof user !== 'object') return user;
    const is_admin = isAdminUser(user);
    const is_normal_user = isNormalUser(user);
    const billing = resolveBillingForEntitlements(user, user.plan, user.trial_ends_at);
    const auth_provider = user.auth_provider || (user.password_hash ? 'email' : 'google');
    return {
        ...user,
        auth_provider,
        is_admin,
        is_normal_user,
        plan: billing.plan,
        trial_ends_at: billing.trial_ends_at,
        has_dashboard_access: hasDashboardAccess(user),
    };
}

/** User payload immediately after email/Google registration — checkout required unless admin. */
export function enrichUserForNewSignup(user) {
    if (!user || typeof user !== 'object') return user;
    const is_admin = isAdminUser(user);
    const is_normal_user = isNormalUser(user);
    const billing = resolveBillingForEntitlements(user, user.plan, user.trial_ends_at);
    const auth_provider = user.auth_provider || (user.password_hash ? 'email' : 'google');
    return {
        ...user,
        auth_provider,
        is_admin,
        is_normal_user,
        plan: billing.plan,
        trial_ends_at: billing.trial_ends_at,
        has_dashboard_access: hasDashboardAccessForNewSignup(user),
    };
}

