import { Router } from 'express';
import { 
    getReviewFunnelConfig, saveReviewFunnelConfig, 
    getLeadFollowupConfig, saveLeadFollowupConfig, 
    toggleRecipe, deleteAutomation 
} from '../controllers/configController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// Applied globally to this router so all routes require authentication
router.use(authenticate);

// GET /api/config/review-funnel — Fetch config for logged-in user
router.get('/review-funnel', getReviewFunnelConfig);

// POST /api/config/review-funnel — Save config for logged-in user
router.post('/review-funnel', saveReviewFunnelConfig);

// GET /api/config/lead-followup
router.get('/lead-followup', getLeadFollowupConfig);

// POST /api/config/lead-followup
router.post('/lead-followup', saveLeadFollowupConfig);

// POST /api/config/toggle
router.post('/toggle', toggleRecipe);

// DELETE /api/config/automation
router.delete('/automation', deleteAutomation);

export default router;
