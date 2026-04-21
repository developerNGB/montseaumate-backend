import jwt from 'jsonwebtoken';
import { getTokenFromRequest } from '../utils/cookieHelpers.js';

/**
 * Authentication middleware.
 * Verifies the JWT token from HttpOnly cookie (preferred) or Authorization header.
 * Attaches the decoded user payload to req.user.
 */
const authenticate = (req, res, next) => {
    // Get token from cookie or Authorization header
    const token = getTokenFromRequest(req);

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Access denied. No token provided.',
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
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
