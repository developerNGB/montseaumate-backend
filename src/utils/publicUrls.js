/** Strip trailing slashes for consistent URL joins. */
export function trimBaseUrl(url) {
    if (typeof url !== 'string') return '';
    return url.trim().replace(/\/+$/, '');
}

/** Public app origin (links, redirects). Set FRONTEND_URL on the server. */
export function frontendBaseUrl() {
    const u = trimBaseUrl(process.env.FRONTEND_URL || '');
    return u || null;
}

/** Public API base (OAuth callbacks, integration redirects). Set BACKEND_URL on the server. */
export function backendBaseUrl() {
    const u = trimBaseUrl(process.env.BACKEND_URL || '');
    return u || null;
}
