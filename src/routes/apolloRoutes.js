import express from 'express';
import apolloController from '../controllers/apolloController.js';
import authMiddleware from '../middleware/authenticate.js';

const router = express.Router();

// All Apollo routes require authentication
router.use(authMiddleware);

/**
 * @route   GET /api/apollo/usage
 * @desc    Marketplace run credits / plan snapshot for current month (UTC)
 * @access  Private
 */
router.get('/usage', apolloController.getMarketplaceUsage);

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

/**
 * @route   POST /api/apollo/test-apify
 * @desc    Test if Apify actors are accessible
 * @access  Private
 */
router.post('/test-apify', apolloController.testApify);

/**
 * @route   POST /api/apify/scrape
 * @desc    Scrape leads via Apify (alias for /api/apollo/scout)
 * @access  Private
 */
router.post('/scrape', apolloController.scoutByNiche);

/**
 * @route   GET /api/apify/jobs/:jobId
 * @desc    Poll Apify background search status
 * @access  Private
 */
router.get('/jobs/:jobId', apolloController.getSearchJob);

export default router;
