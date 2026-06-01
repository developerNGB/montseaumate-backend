/**
 * Cookie Helpers for JWT HttpOnly Cookie Authentication
 * Provides secure cookie settings for production and development
 */

const isProduction = process.env.NODE_ENV === 'production';
const requestedSameSite = String(process.env.COOKIE_SAME_SITE || '').trim().toLowerCase();
const cookieSameSite =
    requestedSameSite === 'strict' || requestedSameSite === 'lax' || requestedSameSite === 'none'
        ? requestedSameSite
        : isProduction
          ? 'none'
          : 'lax';
const cookieSecure =
    String(process.env.COOKIE_SECURE || '').trim().toLowerCase() === 'false'
        ? false
        : cookieSameSite === 'none'
          ? true
          : isProduction;

/**
 * Cookie options for JWT token
 */
export const JWT_COOKIE_OPTIONS = {
    httpOnly: true,      // Prevent JavaScript access
    secure: cookieSecure,
    sameSite: cookieSameSite,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days (matches JWT expiry)
    path: '/',
};

/**
 * Cookie options for refresh token (longer lived)
 */
export const REFRESH_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/',
};

/**
 * Set JWT token as HttpOnly cookie
 * @param {Object} res - Express response object
 * @param {string} token - JWT token
 */
export const setJwtCookie = (res, token) => {
    res.cookie('jwt', token, JWT_COOKIE_OPTIONS);
};

/**
 * Clear JWT cookie (logout)
 * @param {Object} res - Express response object
 */
export const clearJwtCookie = (res) => {
    res.clearCookie('jwt', {
        path: '/',
        secure: cookieSecure,
        sameSite: cookieSameSite,
    });
};

/**
 * Extract token from cookie or Authorization header
 * For backward compatibility during migration
 * @param {Object} req - Express request object
 * @returns {string|null} - JWT token or null
 */
export const getTokenFromRequest = (req) => {
    // First try cookie
    if (req.cookies && req.cookies.jwt) {
        return req.cookies.jwt;
    }
    
    // Fallback to Authorization header (legacy support)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    
    return null;
};
