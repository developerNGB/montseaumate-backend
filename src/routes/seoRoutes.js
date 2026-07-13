import express from 'express';
import pool from '../db/pool.js';
import authenticate from '../middleware/authenticate.js';
import { isNormalUser } from '../utils/adminAccess.js';

const router = express.Router();

router.use(authenticate);

// Block normal users from accessing new SEO Tracker features
router.use((req, res, next) => {
    if (isNormalUser(req.user)) {
        return res.status(403).json({ success: false, message: 'Access denied. Feature not available on your plan.' });
    }
    next();
});

// Mock function to simulate fetching SERP data
const mockSerpFetch = (keyword, location) => {
    return new Promise((resolve) => {
        setTimeout(() => {
            // Generate some randomized data based on keyword length
            const baseRank = Math.floor(Math.random() * 20) + 1;
            resolve({
                my_rank: baseRank,
                competitors: [
                    { name: 'Competitor A', rank: Math.max(1, baseRank - 2) },
                    { name: 'Competitor B', rank: baseRank + 1 },
                    { name: 'Competitor C', rank: baseRank + 3 },
                ]
            });
        }, 1000);
    });
};

// GET all SEO tracking keywords
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, keyword, my_rank, competitors, location, created_at 
             FROM seo_rankings 
             WHERE user_id = $1 
             ORDER BY created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, rankings: result.rows });
    } catch (err) {
        console.error('[SEO] Fetch error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch SEO rankings.' });
    }
});

// POST add a new keyword to track
router.post('/', async (req, res) => {
    try {
        const { keyword, location } = req.body;
        if (!keyword) {
            return res.status(400).json({ success: false, message: 'Keyword is required.' });
        }

        // Initially we might not have the rank, we should fetch it from our mock SERP service
        const serpData = await mockSerpFetch(keyword, location || 'Local');

        const result = await pool.query(
            `INSERT INTO seo_rankings (user_id, keyword, location, my_rank, competitors) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.user.id, keyword, location || 'Local', serpData.my_rank, JSON.stringify(serpData.competitors)]
        );

        res.json({ success: true, tracking: result.rows[0] });
    } catch (err) {
        console.error('[SEO] Add keyword error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to track keyword.' });
    }
});

// POST refresh rankings
router.post('/:id/refresh', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Ensure user owns this tracking
        const current = await pool.query(`SELECT keyword, location FROM seo_rankings WHERE id = $1 AND user_id = $2`, [id, req.user.id]);
        if (current.rows.length === 0) return res.status(404).json({ success: false, message: 'Tracking not found.' });

        const { keyword, location } = current.rows[0];
        
        // Fetch new data
        const serpData = await mockSerpFetch(keyword, location);

        const result = await pool.query(
            `UPDATE seo_rankings 
             SET my_rank = $1, competitors = $2, created_at = NOW() 
             WHERE id = $3 RETURNING *`,
            [serpData.my_rank, JSON.stringify(serpData.competitors), id]
        );

        res.json({ success: true, tracking: result.rows[0] });
    } catch (err) {
        console.error('[SEO] Refresh error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to refresh ranking.' });
    }
});

// DELETE stop tracking keyword
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `DELETE FROM seo_rankings WHERE id = $1 AND user_id = $2 RETURNING id`,
            [id, req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Tracking not found.' });
        }
        res.json({ success: true, message: 'Tracking deleted.' });
    } catch (err) {
        console.error('[SEO] Delete error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to delete tracking.' });
    }
});

export default router;
