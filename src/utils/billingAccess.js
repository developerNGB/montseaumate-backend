import { isAdminUser } from './adminAccess.js';

/**
 * Dashboard access requires a Stripe subscription unless the user is an admin
 * (ADMIN_EMAILS or role === 'admin'). Sign-up alone does not grant access.
 */
export function hasDashboardAccess(user) {
    if (!user) return false;
    if (isAdminUser(user)) return true;
    return !!String(user.stripe_subscription_id || '').trim();
}

/** Client-facing user object with admin + billing flags. */
export function enrichUserForClient(user) {
    if (!user || typeof user !== 'object') return user;
    const is_admin = isAdminUser(user);
    return {
        ...user,
        is_admin,
        has_dashboard_access: hasDashboardAccess(user),
    };
}
