import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import {
    getLeads,
    getLeadFolders,
    updateFolderMessage,
    updateLeadStatus,
    importLeads,
    triggerLeadFollowup,
    triggerBulkFollowup,
    deleteLead,
    bulkDeleteLeads,
    getLeadTimeline,
    sendLeadEmail,
} from '../controllers/leadsController.js';
import authenticate from '../middleware/authenticate.js';

const router = Router();
// Multer: store attachments in memory (max 10 MB per file, max 5 files)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
});

// Protect all /api/leads endpoints
router.use(authenticate);

// GET /api/leads
router.get('/', getLeads);

router.get('/folders', getLeadFolders);
router.put('/folders/message', express.json(), updateFolderMessage);

// GET /api/leads/:id/timeline
router.get('/:id/timeline', getLeadTimeline);

// POST /api/leads/:id/send-email — send an email to this lead (multipart for attachments)
router.post('/:id/send-email', upload.array('files', 5), sendLeadEmail);

// PATCH /api/leads/:id
router.patch('/:id', updateLeadStatus);

// POST /api/leads/import
router.post('/import', importLeads);

// POST /api/leads/:id/trigger  — single lead follow-up
router.post('/:id/trigger', express.json(), triggerLeadFollowup);

// POST /api/leads/trigger-bulk — dispatch follow-ups for recently imported leads
router.post('/trigger-bulk', triggerBulkFollowup);

// DELETE /api/leads/:id — delete single lead
router.delete('/:id', deleteLead);

// POST /api/leads/bulk-delete — delete multiple leads
router.post('/bulk-delete', bulkDeleteLeads);

export default router;
