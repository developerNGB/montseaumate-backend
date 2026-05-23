import { Router } from 'express';
import {
    connectProvider,
    providerCallback,
    renderMockOAuth,
} from '../controllers/integrationController.js';

/**
 * OAuth entry/callback routes — mounted WITHOUT session middleware.
 * Google/Microsoft redirect back here cross-site; SameSite=strict cookies are not sent.
 * Identity is carried in ?token= (connect) and ?state= (callback) JWT instead.
 */
const router = Router();

router.get('/mock-oauth', renderMockOAuth);
router.get('/:provider/connect', connectProvider);
router.get('/:provider/callback', providerCallback);

export default router;
