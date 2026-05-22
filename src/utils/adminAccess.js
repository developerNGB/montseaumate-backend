/**
 * Admin gate — matches requireAdmin middleware.
 * role === 'admin' OR email listed in ADMIN_EMAILS (comma-separated).
 */
export function isAdminUser(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const allowList = String(process.env.ADMIN_EMAILS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    if (!allowList.length) return false;
    return allowList.includes(String(user.email || '').toLowerCase());
}

/** Attach is_admin for API responses consumed by the dashboard. */
export function withAdminFlag(user) {
    if (!user || typeof user !== 'object') return user;
    return { ...user, is_admin: isAdminUser(user) };
}
