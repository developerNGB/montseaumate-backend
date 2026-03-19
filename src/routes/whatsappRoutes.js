import express from 'express';
import { connectWhatsApp, getStatus, disconnectWhatsApp } from '../controllers/whatsappController.js';
import { authMiddleware } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/connect', authMiddleware, connectWhatsApp);
router.get('/status', authMiddleware, getStatus);
router.post('/disconnect', authMiddleware, disconnectWhatsApp);

export default router;
