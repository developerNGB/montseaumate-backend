import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import {
    createCheckoutSession,
    createPortalSession,
    getBillingStatus,
    verifyCheckoutSession,
} from '../controllers/stripeController.js';

const router = Router();

router.get('/billing-status', authenticate, getBillingStatus);
router.post('/create-checkout-session', authenticate, createCheckoutSession);
router.post('/create-portal-session', authenticate, createPortalSession);
router.get('/verify-session', authenticate, verifyCheckoutSession);

export default router;
