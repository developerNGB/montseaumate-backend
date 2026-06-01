import { Router } from 'express';
import {
    createConnectTicket,
    getIntegrations,
    getIntegrationHealth,
    disconnectProvider,
} from '../controllers/integrationController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// GET /api/integrations — List active integrations
router.get('/', authenticate, getIntegrations);

// GET /api/integrations/health — WhatsApp/Gmail status for dashboard alerts
router.get('/health', authenticate, getIntegrationHealth);
router.post('/:provider/connect-ticket', authenticate, createConnectTicket);

// DELETE /api/integrations/:provider — Remove integration
router.delete('/:provider', authenticate, disconnectProvider);

export default router;
