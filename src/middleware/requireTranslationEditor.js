export default function requireTranslationEditor(req, res, next) {
    if (req.user?.email && String(req.user.email).toLowerCase() === 'admin@gmail.com') {
        return next();
    }

    return res.status(403).json({
        success: false,
        message: 'Translation editing is restricted to the administrator account (admin@gmail.com).',
    });
}
