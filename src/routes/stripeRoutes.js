import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import { createCheckoutSession, verifyCheckoutSession } from '../controllers/stripeController.js';

const router = Router();

router.post('/create-checkout-session', authenticate, createCheckoutSession);
router.get('/verify-session', authenticate, verifyCheckoutSession);

export default router;
