import { Router } from 'express';
import { getPublicReviewConfig, submitReview, submitLead, submitFeedback } from '../controllers/publicController.js';

const router = Router();

// Routes are mounted at /api in index.js

// GET /api/r/:automation_id
router.get('/r/:automation_id', getPublicReviewConfig);

// GET /api/l/:automation_id
router.get('/l/:automation_id', getPublicReviewConfig);

// POST /api/f/:automation_id/submit
router.post('/f/:automation_id/submit', submitFeedback);

// POST /api/r/:automation_id/submit
router.post('/r/:automation_id/submit', submitReview);

// POST /api/l/:automation_id/lead
router.post('/l/:automation_id/lead', submitLead);

export default router;
