import { Router } from 'express';
import { getDashboardStats, getEmployeeActivityStatus } from '../controllers/statsController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// Protect endpoints
router.use(authenticate);

// GET /api/stats
router.get('/', getDashboardStats);

// GET /api/stats/activity?employee=followup|review|capture
router.get('/activity', getEmployeeActivityStatus);

export default router;
