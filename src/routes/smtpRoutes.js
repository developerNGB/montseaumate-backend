import express from 'express';
import * as smtpController from '../controllers/smtpController.js';
import authenticate from '../middleware/authenticate.js';

const router = express.Router();

// All SMTP routes require authentication
router.use(authenticate);

router.get('/', smtpController.getSmtpSettings);
router.post('/', smtpController.saveSmtpSettings);
router.post('/detect', smtpController.detectConnection);

// POST /test  → kicks off async SMTP test, returns 202 + jobId immediately
// GET  /test/:jobId → poll for result (pending=202, done=200/400)
// This fire-and-forget pattern avoids nginx gateway timeouts completely.
router.post('/test', smtpController.testConnection);
router.get('/test/:jobId', smtpController.pollTestResult);

router.delete('/', smtpController.deleteSmtpSettings);

export default router;
