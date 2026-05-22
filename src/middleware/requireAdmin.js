import { isAdminUser } from '../utils/adminAccess.js';

/**
 * Simple admin-only gate. Allows access when:
 * - req.user.role === 'admin', or
 * - req.user.email is present in ADMIN_EMAILS (comma-separated) env var.
 */
export default function requireAdmin(req, res, next) {
    try {
        if (isAdminUser(req.user)) return next();
        return res.status(403).json({ success: false, message: 'Admins only.' });
    } catch (e) {
        return res.status(403).json({ success: false, message: 'Admins only.' });
    }
}
