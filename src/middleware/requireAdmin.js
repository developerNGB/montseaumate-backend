/**
 * Simple admin-only gate. Allows access when:
 * - req.user.role === 'admin', or
 * - req.user.email is present in ADMIN_EMAILS (comma-separated) env var.
 */
export default function requireAdmin(req, res, next) {
    try {
        const isAdminRole = req?.user?.role === 'admin';
        const allowList = String(process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const isAllowEmail = allowList.length && allowList.includes(String(req?.user?.email || '').toLowerCase());
        if (isAdminRole || isAllowEmail) return next();
        return res.status(403).json({ success: false, message: 'Admins only.' });
    } catch (e) {
        return res.status(403).json({ success: false, message: 'Admins only.' });
    }
}
