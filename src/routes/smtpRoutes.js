import express from 'express';
import * as smtpController from '../controllers/smtpController.js';
import authenticate from '../middleware/authenticate.js';

const router = express.Router();

// All SMTP routes require authentication
router.use(authenticate);

router.get('/', smtpController.getSmtpSettings);
router.post('/', smtpController.saveSmtpSettings);
router.post('/test', smtpController.testConnection);
router.delete('/', smtpController.deleteSmtpSettings);

export default router;
