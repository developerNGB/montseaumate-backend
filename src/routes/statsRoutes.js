import { Router } from 'express';
import { getDashboardStats, getEmployeeActivityStatus } from '../controllers/statsController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// Protect endpoints
router.use(authenticate);

// GET /api/stats (dashboard payload: recipes, configured, stats, …)
router.get('/', getDashboardStats);
// Legacy path — older frontends called /api/stats/dashboard
router.get('/dashboard', getDashboardStats);

// GET /api/stats/activity?employee=followup|review|capture
router.get('/activity', getEmployeeActivityStatus);

export default router;
