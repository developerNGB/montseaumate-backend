import express from 'express';
import apolloController from '../controllers/apolloController.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// All Apollo routes require authentication
router.use(authMiddleware);

/**
 * @route   POST /api/apollo/search
 * @desc    Search for leads using Apollo API
 * @access  Private
 */
router.post('/search', apolloController.search);

/**
 * @route   POST /api/apollo/scout
 * @desc    Scout leads by niche (real_estate, car_sales, hr, second_hand)
 * @access  Private
 */
router.post('/scout', apolloController.scoutByNiche);

/**
 * @route   POST /api/apollo/enrich
 * @desc    Enrich a specific lead to get contact details
 * @access  Private
 */
router.post('/enrich', apolloController.enrich);

/**
 * @route   GET /api/apollo/niches
 * @desc    Get available niches with their search criteria
 * @access  Private
 */
router.get('/niches', apolloController.getNiches);

export default router;
