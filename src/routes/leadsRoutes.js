import { Router } from 'express';
import { getLeads } from '../controllers/leadsController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// Protect all /api/leads endpoints
router.use(authenticate);

// GET /api/leads
router.get('/', getLeads);

export default router;
