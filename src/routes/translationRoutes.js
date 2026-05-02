import express from 'express';
import { getTranslations, updateTranslation } from '../controllers/translationController.js';
import authenticate from '../middleware/authenticate.js';

const router = express.Router();

// Public read for SPA i18n merge
router.get('/', getTranslations);

// Authenticated write (JWT required — any logged-in user; tighten to admin roles if introduced)
router.post('/update', authenticate, updateTranslation);

export default router;
