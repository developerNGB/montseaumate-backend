import express from 'express';
import { connectWhatsApp, getStatus, disconnectWhatsApp } from '../controllers/whatsappController.js';
import authenticate from '../middleware/authenticate.js';

const router = express.Router();

router.post('/connect', authenticate, connectWhatsApp);
router.get('/status', authenticate, getStatus);
router.post('/disconnect', authenticate, disconnectWhatsApp);

export default router;
