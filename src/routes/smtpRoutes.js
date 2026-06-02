import express from 'express';
import * as smtpController from '../controllers/smtpController.js';
import authenticate from '../middleware/authenticate.js';

const router = express.Router();

// All SMTP routes require authentication
router.use(authenticate);

router.get('/', smtpController.getSmtpSettings);
router.post('/', smtpController.saveSmtpSettings);
router.post('/detect', smtpController.detectConnection);

// SMTP test can take up to 25 s (nodemailer verify + sendMail).
// Apply a 27 s route-level timeout so Express always responds before
// the reverse-proxy's 30 s window and the browser never sees a raw 504.
const smtpTestTimeout = (req, res, next) => {
    const timer = setTimeout(() => {
        if (!res.headersSent) {
            res.status(504).json({
                success: false,
                code: 'smtp_timeout',
                message: 'The mail server did not respond in time.',
                hint: 'Try SSL/TLS on port 465, or Standard security on port 587. Some hosting providers also block outbound SMTP — enable it in cPanel/Plesk first.',
            });
        }
    }, 27000);
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
};
router.post('/test', smtpTestTimeout, smtpController.testConnection);
router.delete('/', smtpController.deleteSmtpSettings);

export default router;
