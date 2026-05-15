import { Router } from 'express';
import { getActivityLogs, retryActivityLog } from '../controllers/activityLogsController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// Apply auth middleware
router.use(authenticate);

// GET /api/activity-logs
router.get('/', getActivityLogs);

// POST /api/activity-logs/:id/retry
router.post('/:id/retry', retryActivityLog);

export default router;
