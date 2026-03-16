import { Router } from 'express';
import { getFeedback, getFeedbackStats } from '../controllers/feedbackController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);

router.get('/', getFeedback);
router.get('/stats', getFeedbackStats);

export default router;
