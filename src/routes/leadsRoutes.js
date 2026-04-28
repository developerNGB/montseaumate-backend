import { Router } from 'express';
import {
    getLeads,
    updateLeadStatus,
    importLeads,
    triggerLeadFollowup,
    triggerBulkFollowup,
    deleteLead,
    bulkDeleteLeads
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

// DELETE /api/leads/:id — delete single lead
router.delete('/:id', deleteLead);

// POST /api/leads/bulk-delete — delete multiple leads
router.post('/bulk-delete', bulkDeleteLeads);

export default router;
