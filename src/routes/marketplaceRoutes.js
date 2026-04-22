import { Router } from 'express';
import authenticate from '../middleware/authenticate.js';
import {
    fetchMarketplaceLeads,
    storeMarketplaceLeads,
    getStoredLeads,
    deleteLead,
    deleteAllLeads
} from '../controllers/marketplaceController.js';

const router = Router();

// POST /api/marketplace/fetch - Fetch leads from N8N webhook
router.post('/fetch', authenticate, fetchMarketplaceLeads);

// POST /api/marketplace/store - Store fetched leads
router.post('/store', authenticate, storeMarketplaceLeads);

// GET /api/marketplace/leads - Get stored leads
router.get('/leads', authenticate, getStoredLeads);

// DELETE /api/marketplace/leads/:id - Delete a lead
router.delete('/leads/:id', authenticate, deleteLead);

// DELETE /api/marketplace/leads - Delete all leads
router.delete('/leads', authenticate, deleteAllLeads);

export default router;
