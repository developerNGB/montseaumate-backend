import { Router } from 'express';
import { getPublicReviewConfig, submitReview, submitLead, submitFeedback } from '../controllers/publicController.js';

const router = Router();

// GET /api/r/:automation_id (Used by frontend to get business name)
router.get('/r/:automation_id', getPublicReviewConfig);

// POST /api/f/:automation_id/submit (Advanced Survey)
router.post('/f/:automation_id/submit', submitFeedback);

// POST /api/r/:automation_id/submit (Standard Review)
router.post('/r/:automation_id/submit', submitReview);

// POST /api/l/:automation_id/lead (Lead Capture)
router.post('/l/:automation_id/lead', submitLead);

export default router;
