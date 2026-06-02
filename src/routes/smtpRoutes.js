import express from 'express';
import * as smtpController from '../controllers/smtpController.js';
import authenticate from '../middleware/authenticate.js';

const router = express.Router();

// All SMTP routes require authentication
router.use(authenticate);

router.get('/', smtpController.getSmtpSettings);
router.post('/', smtpController.saveSmtpSettings);
router.post('/detect', smtpController.detectConnection);

// SMTP test is wrapped in a 12 s Promise.race in emailService.
// This route-level timer is a safety net for cdmon's short nginx proxy window.
const smtpTestTimeout = (req, res, next) => {
    const timer = setTimeout(() => {
        if (!res.headersSent) {
            res.status(504).json({
                success: false,
                code: 'smtp_timeout',
                message: 'The mail server did not respond in time.',
                hint: 'Try SSL/TLS on port 465, or Standard security on port 587. Also make sure outbound SMTP is enabled in cPanel → Email → SMTP Restrictions.',
            });
        }
    }, 12000);
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
};
router.post('/test', smtpTestTimeout, smtpController.testConnection);
router.delete('/', smtpController.deleteSmtpSettings);

export default router;
