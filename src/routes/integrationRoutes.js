import { Router } from 'express';
import {
    createConnectTicket,
    getIntegrations,
    getGoogleReviewLinkSuggestion,
    getGoogleBusinessListings,
    selectGoogleBusinessListing,
    getIntegrationHealth,
    disconnectProvider,
    getGoogleReviews,
    replyToGoogleReview,
    generateAiReply,
    getGooglePosts,
    createGooglePost,
    getGoogleAnalytics,
} from '../controllers/integrationController.js';
import express from 'express';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// GET /api/integrations — List active integrations
router.get('/', authenticate, getIntegrations);

// GET /api/integrations/health — WhatsApp/Gmail status for dashboard alerts
router.get('/health', authenticate, getIntegrationHealth);
router.get('/google/review-link', authenticate, getGoogleReviewLinkSuggestion);
router.get('/google/business-listings', authenticate, getGoogleBusinessListings);
router.post('/google/business-listing', authenticate, express.json(), selectGoogleBusinessListing);
router.post('/:provider/connect-ticket', authenticate, createConnectTicket);

// GBP Interactive features
router.get('/google/reviews', authenticate, getGoogleReviews);
router.post('/google/reviews/:reviewId/reply', authenticate, express.json(), replyToGoogleReview);
router.post('/google/reviews/generate-reply', authenticate, express.json(), generateAiReply);
router.get('/google/posts', authenticate, getGooglePosts);
router.post('/google/posts', authenticate, express.json(), createGooglePost);
router.get('/google/analytics', authenticate, getGoogleAnalytics);

// DELETE /api/integrations/:provider — Remove integration
router.delete('/:provider', authenticate, disconnectProvider);

export default router;

