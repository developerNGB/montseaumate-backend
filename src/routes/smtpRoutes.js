import express from 'express';
import * as smtpController from '../controllers/smtpController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// All SMTP routes require authentication
router.use(authenticateToken);

router.get('/', smtpController.getSmtpSettings);
router.post('/', smtpController.saveSmtpSettings);
router.post('/test', smtpController.testConnection);
router.delete('/', smtpController.deleteSmtpSettings);

export default router;
