import express from 'express';
import { getTranslations, updateTranslation } from '../controllers/translationController.js';

const router = express.Router();

// Publicly accessible to fetch translations
router.get('/', getTranslations);

// Restricted to Admin (should be protected by auth middleware in production)
router.post('/update', updateTranslation);

export default router;
