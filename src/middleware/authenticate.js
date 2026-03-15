import jwt from 'jsonwebtoken';

/**
 * Authentication middleware.
 * Verifies the JWT token from the Authorization header.
 * Attaches the decoded user payload to req.user.
 */
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'Access denied. No token provided.',
        });
    }

    const token = authHeader.split(' ')[1];

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
