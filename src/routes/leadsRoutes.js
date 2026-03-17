import { Router } from 'express';
import { 
    getLeads, 
    updateLeadStatus, 
    importLeads, 
    triggerLeadFollowup 
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

// POST /api/leads/:id/trigger
router.post('/:id/trigger', triggerLeadFollowup);

export default router;
