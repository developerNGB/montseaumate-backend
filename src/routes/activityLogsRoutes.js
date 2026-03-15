import { Router } from 'express';
import { getActivityLogs } from '../controllers/activityLogsController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// Apply auth middleware
router.use(authenticate);

// GET /api/activity-logs
router.get('/', getActivityLogs);

export default router;
