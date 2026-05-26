import { Router } from 'express';
import {
    getPublicReviewConfig,
    submitReview,
    submitLead,
    submitFeedback,
    submitContactForm,
    getContactFormStatus,
} from '../controllers/publicController.js';

const router = Router();

// Routes are mounted at /api in index.js

// Landing Page Contact
router.get('/support/contact/status', getContactFormStatus);
router.post('/support/contact', submitContactForm);

// GET /api/r/:automation_id — star rating review funnel
router.get('/r/:automation_id', getPublicReviewConfig);

// GET /api/f/:automation_id — multi-dimension feedback survey (same config payload)
router.get('/f/:automation_id', getPublicReviewConfig);

// GET /api/l/:automation_id — lead capture form header
router.get('/l/:automation_id', getPublicReviewConfig);

// POST /api/f/:automation_id/submit
router.post('/f/:automation_id/submit', submitFeedback);

// POST /api/r/:automation_id/submit
router.post('/r/:automation_id/submit', submitReview);

// POST /api/l/:automation_id/lead
router.post('/l/:automation_id/lead', submitLead);

export default router;
