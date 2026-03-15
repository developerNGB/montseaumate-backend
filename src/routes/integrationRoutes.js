import { Router } from 'express';
import { getIntegrations, connectProvider, providerCallback, disconnectProvider, renderMockOAuth } from '../controllers/integrationController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();

// GET /api/integrations — List active integrations
router.get('/', authenticate, getIntegrations);

// GET /api/integrations/mock-oauth — Renders Mock HTML (Public, for demo purposes)
router.get('/mock-oauth', renderMockOAuth);

// GET /api/integrations/:provider/connect — Redirect to OAuth provider
// Not using standard 'authenticate' middleware because this is accessed directly via href, so we extract token from query
router.get('/:provider/connect', connectProvider);

// GET /api/integrations/:provider/callback — Handle OAuth redirect from provider (Public, callback)
router.get('/:provider/callback', providerCallback);

// DELETE /api/integrations/:provider — Remove integration
router.delete('/:provider', authenticate, disconnectProvider);

export default router;
