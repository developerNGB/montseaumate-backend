const LOCAL_DEV_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
];

/**
 * Built-in SPA origins so login works even when Render only sets FRONTEND_URL to the custom domain.
 * Requests from Cloudflare Pages use Origin: https://<project>.pages.dev — it must be allowlisted here
 * or in CORS_ORIGINS.
 */
const DEFAULT_BROWSER_ORIGINS = [
    'https://equipoexperto.com',
    'https://www.equipoexperto.com',
    'https://montseaumateii.pages.dev',
    'https://www.montseaumate.com',
];

/**
 * Allowed browser origins for CORS.
 * Includes DEFAULT_BROWSER_ORIGINS + CORS_ORIGINS + FRONTEND_URL (merged, deduped).
 * In non-production, localhost dev origins are appended.
 */
export function getCorsWhitelist() {
    const fromEnv = (process.env.CORS_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const fe = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');

    const set = new Set(DEFAULT_BROWSER_ORIGINS);
    fromEnv.forEach((o) => set.add(o));
    if (fe) set.add(fe);

    if (process.env.NODE_ENV !== 'production') {
        LOCAL_DEV_ORIGINS.forEach((o) => set.add(o));
    }

    return [...set];
}
