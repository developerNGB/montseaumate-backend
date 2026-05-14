import { Router } from 'express';
import { handleStripeWebhook } from '../controllers/stripeController.js';

const router = Router();
router.post('/', handleStripeWebhook);

export default router;
