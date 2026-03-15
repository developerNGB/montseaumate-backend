import { Router } from 'express';
import { getPublicReviewConfig, submitReview, submitLead } from '../controllers/publicController.js';

const router = Router();

// GET /api/r/:automation_id or /api/l/:automation_id
router.get('/:automation_id', getPublicReviewConfig);

// POST /api/r/:automation_id/submit
router.post('/:automation_id/submit', submitReview);

// POST /api/l/:automation_id/lead
router.post('/:automation_id/lead', submitLead);

export default router;
