import { isAdminUser } from './adminAccess.js';

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

/**
 * Dashboard access for app + API: admin, active Stripe sub, or existing account (sign-in).
 * Brand-new sign-ups stay false until checkout (see enrichUserForNewSignup).
 */
export function hasDashboardAccess(user) {
    if (!user) return false;
    if (isAdminUser(user)) return true;
    if (String(user.stripe_subscription_id || '').trim()) return true;
    if (isEstablishedAccount(user)) return true;
    return false;
}

/** Strict gate right after register / Google sign-up (before Stripe checkout). */
export function hasDashboardAccessForNewSignup(user) {
    if (!user) return false;
    if (isAdminUser(user)) return true;
    return !!String(user.stripe_subscription_id || '').trim();
}

/** Client-facing user object with admin + billing flags (normal session). */
export function enrichUserForClient(user) {
    if (!user || typeof user !== 'object') return user;
    const is_admin = isAdminUser(user);
    return {
        ...user,
        is_admin,
        has_dashboard_access: hasDashboardAccess(user),
    };
}

/** User payload immediately after email/Google registration — checkout required unless admin. */
export function enrichUserForNewSignup(user) {
    if (!user || typeof user !== 'object') return user;
    const is_admin = isAdminUser(user);
    return {
        ...user,
        is_admin,
        has_dashboard_access: hasDashboardAccessForNewSignup(user),
    };
}
