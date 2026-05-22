import { listErrorEvents, markErrorResolved } from '../services/errorLogService.js';

export async function getErrors(req, res) {
    try {
        const { q, level, limit, offset } = req.query || {};
        const rows = await listErrorEvents({ q, level, limit: Number(limit)||200, offset: Number(offset)||0 });
        return res.status(200).json({ success: true, errors: rows });
    } catch (e) {
        console.error('[AdminErrors] list failed:', e.message);
        return res.status(500).json({ success: false, message: 'Could not fetch errors' });
    }
}

export async function resolveError(req, res) {
    try {
        const { id } = req.params;
        const { resolved = true } = req.body || {};
        await markErrorResolved(id, Boolean(resolved));
        return res.status(200).json({ success: true });
    } catch (e) {
        console.error('[AdminErrors] resolve failed:', e.message);
        return res.status(500).json({ success: false, message: 'Could not update error status' });
    }
}
