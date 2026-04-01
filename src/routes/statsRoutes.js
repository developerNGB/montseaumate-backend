import { Router } from 'express';
import { getDashboardStats, sendMonthlyReport } from '../controllers/statsController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// Protect endpoints
router.use(authenticate);

// GET /api/stats
router.get('/', getDashboardStats);

// POST /api/stats/monthly-report
router.post('/monthly-report', sendMonthlyReport);

export default router;
