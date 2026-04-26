import apolloService from '../services/apolloService.js';
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

            // Check if Apollo API key is configured
            if (!process.env.APOLLO_API_KEY) {
                return res.status(500).json({
                    success: false,
                    error: 'Apollo API key not configured. Please set APOLLO_API_KEY environment variable.'
                });
            }

            // Search Apollo for leads
            const results = await apolloService.scoutByNiche(niche);

            if (!results.people || results.people.length === 0) {
                return res.json({
                    success: true,
                    data: [],
                    message: 'No leads found for this niche'
                });
            }

            // Enrich first 3 leads to get contact details (these consume credits)
            const enrichedLeads = [];
            const enrichLimit = Math.min(3, results.people.length);

            for (let i = 0; i < enrichLimit; i++) {
                try {
                    const person = results.people[i];
                    const enriched = await apolloService.enrichPerson(person.id);
                    
                    if (enriched.person) {
                        enrichedLeads.push({
                            id: person.id,
                            first_name: enriched.person.first_name,
                            last_name: enriched.person.last_name,
                            email: enriched.person.email,
                            phone: enriched.person.phone,
                            title: enriched.person.title,
                            organization: enriched.person.organization?.name,
                            location: enriched.person.location?.formatted_address,
                            linkedin_url: enriched.person.linkedin_url,
                            enrichment_status: 'success'
                        });
                    }
                } catch (enrichError) {
                    console.log(`Failed to enrich person ${results.people[i].id}:`, enrichError.message);
                    // Add basic info without enrichment
                    enrichedLeads.push({
                        id: results.people[i].id,
                        first_name: results.people[i].first_name,
                        last_name: results.people[i].last_name_obfuscated,
                        title: results.people[i].title,
                        organization: results.people[i].organization?.name,
                        enrichment_status: 'pending',
                        has_email: results.people[i].has_email,
                        has_direct_phone: results.people[i].has_direct_phone
                    });
                }
            }

            // Save discovered leads to database
            const savedLeads = [];
            for (const lead of enrichedLeads) {
                try {
                    const result = await pool.query(
                        `INSERT INTO leads (
                            user_id, full_name, email, phone, 
                            source, lead_status, notes, created_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                        ON CONFLICT (user_id, email) DO NOTHING
                        RETURNING id`,
                        [
                            userId,
                            `${lead.first_name} ${lead.last_name || ''}`.trim(),
                            lead.email || 'pending@apollo.io',
                            lead.phone || '',
                            `Apollo - ${niche}`,
                            'New',
                            JSON.stringify({
                                title: lead.title,
                                organization: lead.organization,
                                location: lead.location,
                                linkedin: lead.linkedin_url,
                                apollo_id: lead.id,
                                enrichment_status: lead.enrichment_status
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
                    'Apollo Scout',
                    'scout',
                    'success',
                    `Discovered ${savedLeads.length} leads for ${niche}`
                ]
            );

            res.json({
                success: true,
                data: {
                    niche,
                    total_found: results.total_entries,
                    leads: savedLeads,
                    enriched_count: enrichedLeads.length,
                    saved_count: savedLeads.length
                }
            });
        } catch (error) {
            console.error('Apollo Scout Error:', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to scout leads'
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
}

export default new ApolloController();
