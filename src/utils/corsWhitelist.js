const LOCAL_DEV_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
];

/**
 * Allowed browser origins for CORS. Set CORS_ORIGINS to a comma-separated list
 * (e.g. https://app.example.com,https://www.example.com). In non-production,
 * localhost dev origins are always appended.
 *
 * If CORS_ORIGINS is empty in production, FRONTEND_URL is used as a single origin
 * (set CORS_ORIGINS explicitly when you use multiple frontends, e.g. Pages + custom domain).
 */
export function getCorsWhitelist() {
    const raw = process.env.CORS_ORIGINS || '';
    let fromEnv = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    if (fromEnv.length === 0 && process.env.NODE_ENV === 'production') {
        const fe = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
        if (fe) {
            fromEnv = [fe];
            console.warn(
                '[CORS] CORS_ORIGINS empty — using FRONTEND_URL only. Add CORS_ORIGINS if the SPA is also served from other origins (www, Pages preview, etc.).'
            );
        } else {
            console.warn(
                '[CORS] CORS_ORIGINS and FRONTEND_URL are empty in production. Browser API calls will be blocked until you set them.'
            );
        }
    }

    const set = new Set(fromEnv);
    if (process.env.NODE_ENV !== 'production') {
        LOCAL_DEV_ORIGINS.forEach((o) => set.add(o));
    }
    return [...set];
}
