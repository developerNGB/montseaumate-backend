import { Router } from 'express';
import { getFeedback, getFeedbackStats } from '../controllers/feedbackController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

router.use(authenticateToken);

router.get('/', getFeedback);
router.get('/stats', getFeedbackStats);

export default router;
