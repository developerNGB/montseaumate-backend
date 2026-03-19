import express from 'express';
import { connectWhatsApp, getStatus, disconnectWhatsApp, sendNativeMessage } from '../controllers/whatsappController.js';
import authenticate from '../middleware/authenticate.js';

const router = express.Router();

router.post('/connect', authenticate, connectWhatsApp);
router.get('/status', authenticate, getStatus);
router.post('/disconnect', authenticate, disconnectWhatsApp);

// Public endpoint for n8n/webhooks to send messages using the native session
router.post('/send', sendNativeMessage);

export default router;
