import { Router } from 'express';
import { getFeedback, getFeedbackStats, draftFeedbackReply } from '../controllers/feedbackController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);

router.get('/', getFeedback);
router.get('/stats', getFeedbackStats);
router.get('/:id/draft-reply', draftFeedbackReply);

export default router;
