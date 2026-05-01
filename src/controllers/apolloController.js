import apolloService from '../services/apolloService.js';
import apifyNicheService from '../services/apifyNicheService.js';
import pool from '../db/pool.js';
import { createHash, randomUUID } from 'crypto';
import {
    getUsageSnapshot,
    incrementMarketplaceUsage,
} from '../services/marketplaceUsageService.js';

const ACTIVE_JOB_STATUSES = ['queued', 'running'];
const SEARCH_COOLDOWN_SECONDS = 60;
const DEFAULT_LEADS_PER_NICHE = 20;

const safeIdentifier = (value, fallbackPrefix = 'apify') => {
    const raw = String(value || `${fallbackPrefix}_${randomUUID()}`);
    if (raw.length <= 180) return raw;

    const hash = createHash('sha1').update(raw).digest('hex');
    return `${fallbackPrefix}_${hash}`;
};

const getRequestedNiches = (body) => {
    if (Array.isArray(body.niches) && body.niches.length) {
        return body.niches.map((niche, index) => ({
            niche,
            query: Array.isArray(body.queries) ? body.queries[index] : body.query,
        }));
    }
    return [{ niche: body.niche, query: body.query }];
};

const toStoredLead = (lead, niche) => {
    const fullName = lead.full_name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || lead.organization || 'Business';
    return {
        id: lead.id,
        first_name: lead.first_name || '',
        last_name: lead.last_name || '',
        full_name: fullName,
        email: lead.email || '',
        phone: lead.phone || '',
        title: lead.title || '',
        organization: lead.organization || fullName,
        location: lead.location || '',
        website: lead.website || '',
        linkedin_url: lead.linkedin_url || '',
        enrichment_status: lead.enrichment_status || 'pending',
        source: lead.source || `Apify - ${niche}`,
        category: niche,
        raw_data: lead.raw_data || lead,
    };
};

const saveDiscoveredLeads = async (client, userId, leads, niche) => {
    let savedCount = 0;
    let saveFailed = false;

    for (const lead of leads) {
        const storedLead = toStoredLead(lead, niche);
        const safeLeadId = safeIdentifier(storedLead.id, 'apify');
        const emailKey = storedLead.email && storedLead.email.includes('@')
            ? storedLead.email
            : `apify_${safeLeadId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}@placeholder.com`;
        const externalId = safeIdentifier(storedLead.id || emailKey, 'lead');
        const notes = {
            title: storedLead.title,
            organization: storedLead.organization,
            location: storedLead.location,
            website: storedLead.website,
            linkedin: storedLead.linkedin_url,
            enrichment_status: storedLead.enrichment_status,
            apify_id: storedLead.id,
        };

        try {
            await client.query(
                `INSERT INTO leads (
                    user_id, full_name, email, phone,
                    source, lead_status, notes, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                ON CONFLICT DO NOTHING`,
                [
                    userId,
                    storedLead.full_name,
                    emailKey,
                    storedLead.phone || '',
                    storedLead.source,
                    'New',
                    JSON.stringify(notes),
                ]
            );

            await client.query(
                `INSERT INTO marketplace_leads (
                    user_id, external_id, source, category, title, currency,
                    location, url, description, fetched_at,
                    seller_name, seller_phone, seller_email, contact_url, raw_data
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13,$14
                )
                ON CONFLICT (user_id, external_id) DO UPDATE SET
                    source = EXCLUDED.source,
                    category = EXCLUDED.category,
                    title = EXCLUDED.title,
                    location = EXCLUDED.location,
                    url = EXCLUDED.url,
                    seller_name = EXCLUDED.seller_name,
                    seller_phone = EXCLUDED.seller_phone,
                    seller_email = EXCLUDED.seller_email,
                    contact_url = EXCLUDED.contact_url,
                    raw_data = EXCLUDED.raw_data,
                    fetched_at = NOW()`,
                [
                    userId,
                    externalId,
                    storedLead.source,
                    niche,
                    storedLead.full_name,
                    'EUR',
                    storedLead.location,
                    storedLead.website || null,
                    storedLead.title || storedLead.organization || null,
                    storedLead.full_name,
                    storedLead.phone || null,
                    storedLead.email || null,
                    storedLead.website || null,
                    JSON.stringify({ ...storedLead, notes }),
                ]
            );

            savedCount++;
        } catch (dbError) {
            saveFailed = true;
            console.error('Failed to save marketplace lead:', dbError.message);
        }
    }

    return { savedCount, saveFailed };
};

const runMarketplaceJob = async ({ jobId, userId, requests, location, requestedLimit, perNicheLimit }) => {
    const client = await pool.connect();
    let allLeads = [];
    let totalSaved = 0;
    let saveFailed = false;

    try {
        await client.query(
            `UPDATE marketplace_search_jobs
             SET status = 'running', started_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND user_id = $2`,
            [jobId, userId]
        );

        let remaining = requestedLimit;
        for (const request of requests) {
            if (remaining <= 0) break;

            const limitForNiche = Math.min(perNicheLimit, remaining);
            const results = await apifyNicheService.scoutByNiche(
                request.niche,
                location,
                request.query,
                { maxResults: limitForNiche }
            );
            const scrapedLeads = (results.people || []).slice(0, limitForNiche).map(lead => toStoredLead(lead, request.niche));
            remaining -= scrapedLeads.length;
            allLeads = allLeads.concat(scrapedLeads);

            const saveResult = await saveDiscoveredLeads(client, userId, scrapedLeads, request.niche);
            totalSaved += saveResult.savedCount;
            saveFailed = saveFailed || saveResult.saveFailed;
        }

        await incrementMarketplaceUsage(client, userId, allLeads.length);

        try {
            await client.query(
                `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [
                    userId,
                    'Marketplace Lead Search',
                    'scout',
                    saveFailed ? 'attention' : 'success',
                    `Discovered ${allLeads.length} leads in ${location}`,
                ]
            );
        } catch (activityError) {
            console.error('Failed to log marketplace lead search activity:', activityError.message);
        }

        await client.query(
            `UPDATE marketplace_search_jobs
             SET status = 'completed',
                 fetched_count = $3,
                 saved_count = $4,
                 result_summary = $5,
                 completed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1 AND user_id = $2`,
            [
                jobId,
                userId,
                allLeads.length,
                totalSaved,
                JSON.stringify({
                    leads: allLeads,
                    save_failed: saveFailed,
                    location,
                    total_found: allLeads.length,
                    saved_count: totalSaved,
                    source: 'Google Maps via Apify',
                }),
            ]
        );
    } catch (error) {
        console.error('[MarketplaceJob] failed:', error);
        await client.query(
            `UPDATE marketplace_search_jobs
             SET status = 'failed', error_message = $3, completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND user_id = $2`,
            [jobId, userId, error.message || 'Lead search failed']
        );
    } finally {
        client.release();
    }
};

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
            const { location, perPage = DEFAULT_LEADS_PER_NICHE } = req.body;
            const userId = req.user.id;
            const requests = getRequestedNiches(req.body)
                .filter(item => item.niche)
                .map(item => ({
                    niche: String(item.niche),
                    query: item.query ? String(item.query) : '',
                }));

            if (!requests.length) {
                return res.status(400).json({
                    success: false,
                    error: 'Choose at least one business group before starting a search.'
                });
            }

            if (!location || !String(location).trim()) {
                return res.status(400).json({
                    success: false,
                    error: 'City is required before starting a Marketplace search.'
                });
            }

            // Check if Apify API token is configured
            if (!process.env.APIFY_API_TOKEN) {
                return res.status(500).json({
                    success: false,
                    error: 'Apify API token not configured. Please set APIFY_API_TOKEN environment variable.'
                });
            }

            const client = await pool.connect();
            try {
                const usage = await getUsageSnapshot(client, userId);

                if (usage.limit <= 0) {
                    return res.status(403).json({
                        success: false,
                        code: 'MARKETPLACE_NOT_INCLUDED',
                        error: 'Marketplace lead search is not included in the free trial. Please choose a paid plan to use it.',
                        usage,
                    });
                }

                if (usage.remaining <= 0) {
                    return res.status(403).json({
                        success: false,
                        code: 'MARKETPLACE_LIMIT_REACHED',
                        error: `You have used all ${usage.limit} Marketplace leads for this month.`,
                        usage,
                    });
                }

                const activeJob = await client.query(
                    `SELECT id, status
                     FROM marketplace_search_jobs
                     WHERE user_id = $1 AND status = ANY($2::text[])
                     ORDER BY created_at DESC
                     LIMIT 1`,
                    [userId, ACTIVE_JOB_STATUSES]
                );
                if (activeJob.rows[0]) {
                    return res.status(409).json({
                        success: false,
                        code: 'MARKETPLACE_JOB_ACTIVE',
                        error: 'A lead search is already running. You can leave this page and come back when it finishes.',
                        jobId: activeJob.rows[0].id,
                    });
                }

                const recentJob = await client.query(
                    `SELECT id, created_at
                     FROM marketplace_search_jobs
                     WHERE user_id = $1 AND created_at > NOW() - ($2 || ' seconds')::interval
                     ORDER BY created_at DESC
                     LIMIT 1`,
                    [userId, SEARCH_COOLDOWN_SECONDS]
                );
                if (recentJob.rows[0]) {
                    return res.status(429).json({
                        success: false,
                        code: 'MARKETPLACE_COOLDOWN',
                        error: 'Please wait a minute before starting another Marketplace search.',
                    });
                }

                const perNicheLimit = Math.max(1, Math.min(Number(perPage) || DEFAULT_LEADS_PER_NICHE, DEFAULT_LEADS_PER_NICHE));
                const requestedLimit = Math.min(usage.remaining, perNicheLimit * requests.length);
                const jobId = randomUUID();

                await client.query(
                    `INSERT INTO marketplace_search_jobs (
                        id, user_id, niche, query, location, status,
                        requested_limit, result_summary, created_at, updated_at
                    ) VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,NOW(),NOW())`,
                    [
                        jobId,
                        userId,
                        requests.map(item => item.niche).join(','),
                        requests.map(item => item.query).filter(Boolean).join(' | '),
                        String(location).trim(),
                        requestedLimit,
                        JSON.stringify({ requests }),
                    ]
                );

                setImmediate(() => {
                    runMarketplaceJob({
                        jobId,
                        userId,
                        requests,
                        location: String(location).trim(),
                        requestedLimit,
                        perNicheLimit,
                    });
                });

                return res.status(202).json({
                    success: true,
                    jobId,
                    status: 'queued',
                    message: 'Lead search started. Results usually take 4-5 minutes. You can leave this page and we will save the results automatically.',
                    usage: {
                        ...usage,
                        reserved: requestedLimit,
                    },
                });
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Apify Scout Error:', {
                message: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to start lead search via Apify'
            });
        }
    }

    async getSearchJob(req, res) {
        try {
            const { jobId } = req.params;
            const jobRes = await pool.query(
                `SELECT *
                 FROM marketplace_search_jobs
                 WHERE id = $1 AND user_id = $2`,
                [jobId, req.user.id]
            );
            const job = jobRes.rows[0];

            if (!job) {
                return res.status(404).json({ success: false, error: 'Search job not found.' });
            }

            const usage = await getUsageSnapshot(pool, req.user.id);
            const summary = job.result_summary || {};

            return res.json({
                success: true,
                job: {
                    id: job.id,
                    status: job.status,
                    niche: job.niche,
                    query: job.query,
                    location: job.location,
                    fetched_count: job.fetched_count,
                    saved_count: job.saved_count,
                    error_message: job.error_message,
                    created_at: job.created_at,
                    completed_at: job.completed_at,
                },
                data: {
                    total_found: summary.total_found || job.fetched_count || 0,
                    leads: summary.leads || [],
                    saved_count: summary.saved_count ?? job.saved_count,
                    save_failed: summary.save_failed || false,
                    location: job.location,
                    source: summary.source || 'Google Maps via Apify',
                },
                usage,
            });
        } catch (error) {
            console.error('Apify Job Error:', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to fetch lead search status'
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
