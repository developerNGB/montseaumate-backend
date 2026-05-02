import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import { setJwtCookie } from './cookieHelpers.js';

/**
 * Same payload shape as issued on login/register (see authController.signToken callers).
 */
export function signAccessToken(user) {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is not configured');
    }
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: user.role,
            plan: user.plan,
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );
}

/** Min 5 minutes, max 14 days; default 48 hours before JWT exp. */
function renewIfExpiresWithinSeconds() {
    const raw = process.env.JWT_RENEW_IF_EXPIRES_WITHIN_SECONDS;
    const n = parseInt(raw ?? '', 10);
    if (Number.isFinite(n)) {
        return Math.min(Math.max(n, 300), 86400 * 14);
    }
    return 2 * 24 * 3600;
}

function userPayloadFromDecoded(decoded) {
    return {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role,
        plan: decoded.plan,
    };
}

/**
 * Sliding session: when the JWT is close to expiry, load the user from DB,
 * mint a new JWT, expose it via X-New-Access-Token (+ HttpOnly cookie), and
 * attach fresh claims to req.user (e.g. plan changes).
 */
export async function maybeRenewAccessJwt(req, res, decoded) {
    if (!decoded?.id) {
        req.user = decoded || {};
        return;
    }

    const base = userPayloadFromDecoded(decoded);
    req.user = base;

    const now = Math.floor(Date.now() / 1000);
    const within = renewIfExpiresWithinSeconds();
    if (!decoded.exp || decoded.exp - now > within) {
        return;
    }

    try {
        const r = await pool.query(
            `SELECT id, email, role, plan, status FROM users WHERE id = $1`,
            [decoded.id]
        );
        const row = r.rows[0];
        if (!row || row.status !== 'active') {
            return;
        }

        const freshUser = {
            id: row.id,
            email: row.email,
            role: row.role,
            plan: row.plan,
        };
        const newToken = signAccessToken(freshUser);
        res.setHeader('X-New-Access-Token', newToken);
        setJwtCookie(res, newToken);
        req.user = freshUser;
    } catch (err) {
        console.warn('[maybeRenewAccessJwt]', err.message);
    }
}
