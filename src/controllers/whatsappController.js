import * as whatsappService from '../services/whatsappService.js';
import pool from '../db/pool.js';

export const connectWhatsApp = async (req, res) => {
    try {
        await whatsappService.initWhatsAppClient(req.user.id);
        res.json({ success: true, message: 'Initialization started' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const getStatus = async (req, res) => {
    try {
        const statusData = whatsappService.getSessionStatus(req.user.id);
        
        // Ensure DB consistency if it somehow shows disconnected in-memory but connected in DB
        // e.g. server restarted but restore hasn't completed
        if (statusData.status === 'disconnected') {
            const dbCheck = await pool.query('SELECT 1 FROM integrations WHERE user_id = $1 AND provider = $2', [req.user.id, 'whatsapp']);
            if (dbCheck.rows.length > 0) {
                 statusData.status = 'restoring'; // UI should reflect that it is restoring or "connected" eventually
            }
        }

        res.json({ success: true, ...statusData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const disconnectWhatsApp = async (req, res) => {
    try {
        await whatsappService.disconnectClient(req.user.id);
        await pool.query('DELETE FROM integrations WHERE user_id = $1 AND provider = $2', [req.user.id, 'whatsapp']);
        res.json({ success: true, message: 'Disconnected' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Public endpoint used by n8n or other webhooks to send messages 
 * via the native connected WhatsApp session.
 */
export const sendNativeMessage = async (req, res) => {
    try {
        const { whatsapp_access_token, phone, message } = req.body;

        if (!whatsapp_access_token || !phone || !message) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // 1. Authorize: Find the user who owns this native session token
        const authCheck = await pool.query(
            "SELECT user_id FROM integrations WHERE provider = 'whatsapp' AND access_token = $1",
            [whatsapp_access_token]
        );

        if (authCheck.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid session token' });
        }

        const userId = authCheck.rows[0].user_id;

        // 2. Dispatch via the Baileys session
        await whatsappService.sendWhatsAppMessage(userId, phone, message);

        return res.json({ success: true, message: 'Message queued for sending' });

    } catch (err) {
        console.error('[sendNativeMessage] Error:', err.message);
        return res.status(500).json({ success: false, message: err.message || 'Failed to dispatch message' });
    }
};
