import apolloService from '../services/apolloService.js';
import apifyNicheService from '../services/apifyNicheService.js';
import pool from '../db/pool.js';

/**
 * Apollo Controller
 * Handles lead discovery and enrichment via Apollo.io API
 */
class ApolloController {
    /**
     * Search for leads based on criteria
     * POST /api/apollo/search
     */
    async search(req, res) {
        try {
            const { titles, locations, keywords, page = 1, perPage = 10 } = req.body;

            const results = await apolloService.searchPeople({
                titles,
                locations,
                keywords,
                page,
                perPage
            });

            res.json({
                success: true,
                data: results
            });
        } catch (error) {
            console.error('Apollo Search Error:', error);
            res.status(500).json({
                success: false,
                error: error.response?.data?.error || 'Failed to search Apollo'
            });
        }
    }

    /**
     * Scout leads by niche (real_estate, car_sales, hr, second_hand)
     * POST /api/apollo/scout
     * Uses Apify Google Maps scraper to find B2B leads
     */
    async scoutByNiche(req, res) {
        try {
            const { niche, location, page = 1, perPage = 10 } = req.body;
            const userId = req.user.id;

            if (!niche) {
                return res.status(400).json({
                    success: false,
                    error: 'Niche is required (real_estate, car_sales, hr, second_hand)'
                });
            }

            // Check if Apify API token is configured
            if (!process.env.APIFY_API_TOKEN) {
                return res.status(500).json({
                    success: false,
                    error: 'Apify API token not configured. Please set APIFY_API_TOKEN environment variable.'
                });
            }

            // Use Apify to scrape for leads
            console.log(`🔍 Starting Apify scrape for niche: ${niche}, location: ${location}`);
            const results = await apifyNicheService.scoutByNiche(niche, location);
            
            console.log(`📊 Apify results:`, {
                peopleCount: results.people?.length,
                totalEntries: results.total_entries,
                error: results.error,
                niche: results.niche
            });

            if (!results.people || results.people.length === 0) {
                return res.json({
                    success: true,
                    data: [],
                    message: results.error || 'No leads found for this niche. Make sure to add the Apify actors to your account from the Apify Store.',
                    debug: results.error
                });
            }

            // Process scraped leads (Apify already provides contact info)
            const scrapedLeads = results.people.map(lead => ({
                id: lead.id,
                first_name: lead.first_name,
                last_name: lead.last_name,
                email: lead.email,
                phone: lead.phone,
                title: lead.title,
                organization: lead.organization,
                location: lead.location,
                website: lead.website,
                linkedin_url: lead.linkedin_url,
                enrichment_status: lead.enrichment_status,
                source: lead.source
            }));

            // Save discovered leads to database
            const savedLeads = [];
            for (const lead of scrapedLeads) {
                try {
                    // Generate a unique email if none provided to avoid conflicts
                    const emailKey = lead.email && lead.email.includes('@') 
                        ? lead.email 
                        : `apify_${lead.id}@placeholder.com`;
                    
                    const result = await pool.query(
                        `INSERT INTO leads (
                            user_id, full_name, email, phone, 
                            source, lead_status, notes, created_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                        ON CONFLICT (user_id, email) DO UPDATE SET
                            phone = EXCLUDED.phone,
                            notes = EXCLUDED.notes
                        RETURNING id`,
                        [
                            userId,
                            lead.full_name || `${lead.first_name} ${lead.last_name || ''}`.trim(),
                            emailKey,
                            lead.phone || '',
                            lead.source || `Apify - ${niche}`,
                            'New',
                            JSON.stringify({
                                title: lead.title,
                                organization: lead.organization,
                                location: lead.location,
                                website: lead.website,
                                linkedin: lead.linkedin_url,
                                enrichment_status: lead.enrichment_status,
                                apify_id: lead.id
                            })
                        ]
                    );
                    
                    if (result.rows.length > 0) {
                        savedLeads.push({ ...lead, db_id: result.rows[0].id });
                    }
                } catch (dbError) {
                    console.error('Failed to save lead:', dbError);
                }
            }

            // Log the activity
            await pool.query(
                `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [
                    userId,
                    'Apify Niche Scout',
                    'scout',
                    'success',
                    `Discovered ${savedLeads.length} leads for ${niche} via Google Maps scraping`
                ]
            );

            res.json({
                success: true,
                data: {
                    niche,
                    total_found: results.total_entries,
                    leads: savedLeads,
                    enriched_count: savedLeads.filter(l => l.enrichment_status === 'found').length,
                    saved_count: savedLeads.length,
                    location: location || 'All locations',
                    source: 'Google Maps via Apify'
                }
            });
        } catch (error) {
            console.error('Apify Scout Error:', {
                message: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to scout leads via Apify'
            });
        }
    }

    /**
     * Enrich a specific lead to get full contact details
     * POST /api/apollo/enrich
     */
    async enrich(req, res) {
        try {
            const { apolloId } = req.body;

            if (!apolloId) {
                return res.status(400).json({
                    success: false,
                    error: 'Apollo ID is required'
                });
            }

            const enriched = await apolloService.enrichPerson(apolloId);

            res.json({
                success: true,
                data: enriched
            });
        } catch (error) {
            console.error('Apollo Enrich Error:', error);
            res.status(500).json({
                success: false,
                error: error.response?.data?.error || 'Failed to enrich lead'
            });
        }
    }

    /**
     * Get available niches with their search criteria
     * GET /api/apollo/niches
     */
    async getNiches(req, res) {
        const niches = {
            real_estate: {
                name: 'Real Estate',
                titles: ['Real Estate Agent', 'Broker', 'Property Manager', 'Agency Owner'],
                keywords: 'real estate, property, realtor, listings',
                description: 'Real estate agents, brokers, and property managers'
            },
            car_sales: {
                name: 'Car Sales / Automotive',
                titles: ['Sales Manager', 'Dealership Owner', 'Automotive Sales', 'Fleet Manager'],
                keywords: 'car sales, dealership, automotive, vehicle sales',
                description: 'Car dealership owners and sales managers'
            },
            hr: {
                name: 'Human Resources / Recruitment',
                titles: ['HR Director', 'Talent Acquisition', 'Human Resources Manager', 'Recruiter'],
                keywords: 'recruitment, staffing, hr, hiring, talent',
                description: 'HR directors and recruitment specialists'
            },
            second_hand: {
                name: 'Second Hand / Retail',
                titles: ['Store Owner', 'Retail Manager', 'E-commerce Manager', 'Boutique Owner'],
                keywords: 'second hand, vintage, clothes, resale, thrift',
                description: 'Second-hand store owners and retail managers'
            }
        };

        res.json({
            success: true,
            data: niches
        });
    }

    /**
     * Test if Apify actors are accessible
     * POST /api/apollo/test-apify
     */
    async testApify(req, res) {
        try {
            const axios = (await import('axios')).default;
            const token = process.env.APIFY_API_TOKEN;
            
            if (!token) {
                return res.status(500).json({
                    success: false,
                    error: 'APIFY_API_TOKEN not configured'
                });
            }

            // Test actor accessibility
            const actorsToTest = [
                'olympus~realtor-leads-real-estate-agent-scraper',
                'samstorm~auto-dealer-lead-scraper'
            ];

            const results = {};
            
            for (const actorId of actorsToTest) {
                try {
                    // Try to get actor info (doesn't run it, just checks if accessible)
                    const response = await axios.get(
                        `https://api.apify.com/v2/acts/${actorId}?token=${token}`
                    );
                    results[actorId] = {
                        accessible: true,
                        name: response.data?.data?.name || 'Unknown',
                        isPublic: response.data?.data?.isPublic || false
                    };
                } catch (err) {
                    results[actorId] = {
                        accessible: false,
                        error: err.response?.data?.error || err.message,
                        status: err.response?.status
                    };
                }
            }

            res.json({
                success: true,
                message: 'Actor accessibility test complete',
                tokenConfigured: true,
                results
            });
        } catch (error) {
            console.error('Test Apify Error:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
}

export default new ApolloController();
