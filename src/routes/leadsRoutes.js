import { Router } from 'express';
import {
    getLeads,
    updateLeadStatus,
    importLeads,
    triggerLeadFollowup,
    triggerBulkFollowup
} from '../controllers/leadsController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// Protect all /api/leads endpoints
router.use(authenticate);

// GET /api/leads
router.get('/', getLeads);

// PATCH /api/leads/:id
router.patch('/:id', updateLeadStatus);

// POST /api/leads/import
router.post('/import', importLeads);

// POST /api/leads/:id/trigger  — single lead follow-up
router.post('/:id/trigger', triggerLeadFollowup);

// POST /api/leads/trigger-bulk — dispatch follow-ups for recently imported leads
router.post('/trigger-bulk', triggerBulkFollowup);

export default router;
