import express from 'express';
import { getTranslations, updateTranslation } from '../controllers/translationController.js';
import authenticate from '../middleware/authenticate.js';
import requireTranslationEditor from '../middleware/requireTranslationEditor.js';

const router = express.Router();

// Public read for SPA i18n merge
router.get('/', getTranslations);

// Authenticated write — optional TRANSLATION_EDITOR_USER_IDS env allowlist
router.post('/update', authenticate, requireTranslationEditor, updateTranslation);

export default router;
