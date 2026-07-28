import { Router } from 'express';
import { getFeedback, getFeedbackStats, draftFeedbackReply, replyToFeedback } from '../controllers/feedbackController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);

router.get('/', getFeedback);
router.get('/stats', getFeedbackStats);
router.get('/:id/draft-reply', draftFeedbackReply);
router.post('/:id/reply', replyToFeedback);

export default router;
