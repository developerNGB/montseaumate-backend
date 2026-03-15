import { Router } from 'express';
import { getDashboardStats } from '../controllers/statsController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// Protect endpoints
router.use(authenticate);

// GET /api/stats
router.get('/', getDashboardStats);

export default router;
