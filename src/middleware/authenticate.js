import jwt from 'jsonwebtoken';
import { getTokenFromRequest } from '../utils/cookieHelpers.js';
import { maybeRenewAccessJwt } from '../utils/accessToken.js';

/**
 * Authentication middleware.
 * Verifies the JWT token from HttpOnly cookie (preferred) or Authorization header.
 * Attaches the decoded user payload to req.user.
 * When the token is close to expiry, issues a new JWT (sliding session).
 */
const authenticate = (req, res, next) => {
    if (!process.env.JWT_SECRET) {
        console.error('[authenticate] JWT_SECRET is missing — rejecting request');
        return res.status(500).json({
            success: false,
            message: 'Server authentication is not configured.',
        });
    }

    const token = getTokenFromRequest(req);

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Access denied. No token provided.',
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        maybeRenewAccessJwt(req, res, decoded)
            .then(() => next())
            .catch(next);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: 'Token has expired. Please log in again.',
            });
        }
        return res.status(401).json({
            success: false,
            message: 'Invalid token.',
        });
    }
};

export default authenticate;
