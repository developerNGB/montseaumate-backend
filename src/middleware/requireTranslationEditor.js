/**
 * Optional lockdown for POST /api/translations/update.
 * - If TRANSLATION_EDITOR_USER_IDS is unset → any authenticated user may edit (legacy behavior).
 * - If set → only listed user UUIDs or users with JWT role === 'admin'.
 */
export default function requireTranslationEditor(req, res, next) {
    const raw = process.env.TRANSLATION_EDITOR_USER_IDS?.trim();
    if (!raw) return next();

    if (req.user?.role === 'admin') return next();

    const allowedIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const userId = req.user?.id != null ? String(req.user.id) : '';
    if (userId && allowedIds.includes(userId)) return next();

    return res.status(403).json({
        success: false,
        message: 'Translation editing is restricted for your account.',
    });
}
