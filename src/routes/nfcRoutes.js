import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import authenticate from '../middleware/authenticate.js';

const router = express.Router();

// Generate a random 6-character alphanumeric shortcode
const generateShortCode = () => {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// 1. PUBLIC ROUTE: Handle NFC taps
// E.g., user taps card, opens equipoexperto.com/api/t/XY12ZA
router.get('/t/:code', async (req, res) => {
    try {
        const { code } = req.params;
        
        // Find the NFC card
        const cardResult = await pool.query(
            `SELECT id, funnel_id FROM nfc_cards WHERE short_code = $1`,
            [code.toUpperCase()]
        );
        
        if (cardResult.rows.length === 0) {
            return res.status(404).send('NFC Card not found or deactivated.');
        }
        
        const card = cardResult.rows[0];
        
        // Increment scan count
        await pool.query(
            `UPDATE nfc_cards SET scans = scans + 1 WHERE id = $1`,
            [card.id]
        );
        
        // Redirect to the public feedback funnel
        // Assuming public funnels are hosted at /r/:automation_id or /f/:automation_id
        // We will default to /f/:automation_id
        const redirectUrl = `/f/${card.funnel_id}`;
        res.redirect(302, redirectUrl);
    } catch (err) {
        console.error('[NFC] Error resolving tap:', err.message);
        res.status(500).send('An error occurred.');
    }
});

// Everything below requires authentication
router.use(authenticate);

// 2. GET all NFC cards for user
router.get('/cards', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, funnel_id, card_name, short_code, scans, created_at
             FROM nfc_cards 
             WHERE user_id = $1 
             ORDER BY created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, cards: result.rows });
    } catch (err) {
        console.error('[NFC] Fetch cards error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch NFC cards.' });
    }
});

// 3. POST create a new NFC card link
router.post('/cards', async (req, res) => {
    try {
        const { funnel_id, card_name } = req.body;
        
        if (!funnel_id || !card_name) {
            return res.status(400).json({ success: false, message: 'Funnel ID and Card Name are required.' });
        }

        // Generate unique shortcode
        let shortCode;
        let isUnique = false;
        let attempts = 0;
        
        while (!isUnique && attempts < 5) {
            shortCode = generateShortCode();
            const check = await pool.query(`SELECT id FROM nfc_cards WHERE short_code = $1`, [shortCode]);
            if (check.rows.length === 0) {
                isUnique = true;
            }
            attempts++;
        }

        if (!isUnique) {
            return res.status(500).json({ success: false, message: 'Failed to generate unique shortcode. Please try again.' });
        }

        const insertResult = await pool.query(
            `INSERT INTO nfc_cards (user_id, funnel_id, card_name, short_code) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [req.user.id, funnel_id, card_name, shortCode]
        );

        res.json({ success: true, card: insertResult.rows[0] });
    } catch (err) {
        console.error('[NFC] Create card error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to create NFC card.' });
    }
});

// 4. DELETE an NFC card
router.delete('/cards/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `DELETE FROM nfc_cards WHERE id = $1 AND user_id = $2 RETURNING id`,
            [id, req.user.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Card not found.' });
        }
        
        res.json({ success: true, message: 'Card deleted successfully.' });
    } catch (err) {
        console.error('[NFC] Delete card error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to delete NFC card.' });
    }
});

export default router;
