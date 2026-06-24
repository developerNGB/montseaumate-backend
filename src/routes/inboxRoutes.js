import express from 'express';
import pool from '../db/pool.js';
import { sendWhatsAppMessage, getSessionStatus } from '../services/whatsappService.js';
import authenticate from '../middleware/authenticate.js';

const router = express.Router();
router.use(authenticate);

// 1. Get all conversations for the user
router.get('/conversations', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, contact_phone, contact_email, contact_name, channel, last_message_time, last_message_text, is_read
             FROM inbox_conversations 
             WHERE user_id = $1 
             ORDER BY last_message_time DESC`,
            [req.user.id]
        );
        res.json({ success: true, conversations: result.rows });
    } catch (err) {
        console.error('[Inbox] Fetch conversations error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch conversations.' });
    }
});

// 2. Get messages for a specific conversation
router.get('/conversations/:id/messages', async (req, res) => {
    try {
        const convId = req.params.id;
        // Verify ownership
        const convCheck = await pool.query(`SELECT id FROM inbox_conversations WHERE id = $1 AND user_id = $2`, [convId, req.user.id]);
        if (convCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Conversation not found.' });
        }

        const result = await pool.query(
            `SELECT id, sender_type, text, created_at, is_read
             FROM inbox_messages 
             WHERE conversation_id = $1 
             ORDER BY created_at ASC`,
            [convId]
        );
        
        // Mark as read
        await pool.query(`UPDATE inbox_messages SET is_read = TRUE WHERE conversation_id = $1 AND sender_type = 'contact'`, [convId]);
        await pool.query(`UPDATE inbox_conversations SET is_read = TRUE WHERE id = $1`, [convId]);

        res.json({ success: true, messages: result.rows });
    } catch (err) {
        console.error('[Inbox] Fetch messages error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch messages.' });
    }
});

// 3. Send a reply
router.post('/conversations/:id/reply', async (req, res) => {
    try {
        const convId = req.params.id;
        const { text } = req.body;
        
        if (!text) {
            return res.status(400).json({ success: false, message: 'Message text is required.' });
        }

        // Verify ownership and get contact details
        const convCheck = await pool.query(
            `SELECT id, channel, contact_phone FROM inbox_conversations WHERE id = $1 AND user_id = $2`, 
            [convId, req.user.id]
        );
        if (convCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Conversation not found.' });
        }

        const conv = convCheck.rows[0];

        if (conv.channel === 'whatsapp') {
            // Check WhatsApp status
            const waStatus = getSessionStatus(req.user.id);
            if (waStatus.status !== 'connected') {
                return res.status(400).json({ success: false, message: 'WhatsApp is not connected.' });
            }

            // Send WhatsApp message
            await sendWhatsAppMessage(req.user.id, conv.contact_phone, text);
            
            // Insert into messages table
            const msgInsert = await pool.query(
                `INSERT INTO inbox_messages (conversation_id, sender_type, text) 
                 VALUES ($1, 'business', $2) RETURNING *`,
                [convId, text]
            );

            // Update conversation last message
            await pool.query(
                `UPDATE inbox_conversations 
                 SET last_message_text = $1, last_message_time = NOW() 
                 WHERE id = $2`,
                [text, convId]
            );

            return res.json({ success: true, message: msgInsert.rows[0] });
        } else {
            return res.status(400).json({ success: false, message: 'Replying to this channel is not supported yet.' });
        }

    } catch (err) {
        console.error('[Inbox] Send reply error:', err.message);
        res.status(500).json({ success: false, message: err.message || 'Failed to send reply.' });
    }
});

export default router;
