import express from 'express';
import authenticate from '../middleware/authenticate.js';
import requireAdmin from '../middleware/requireAdmin.js';
import { getErrors, resolveError } from '../controllers/adminErrorsController.js';

const router = express.Router();

router.use(authenticate, requireAdmin);

router.get('/errors', getErrors);
router.patch('/errors/:id', express.json(), resolveError);

router.get('/errors/test', (req, res) => { throw new Error('Test error capture'); });

export default router;

