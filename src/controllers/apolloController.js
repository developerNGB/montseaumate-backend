import apolloService from '../services/apolloService.js';
import apifyNicheService from '../services/apifyNicheService.js';
import pool from '../db/pool.js';
import { createHash, randomUUID } from 'crypto';
import * as whatsappService from '../services/whatsappService.js';
import { getPlanEntitlements } from '../services/subscriptionPlans.js';
import {
    getUsageSnapshot,
    incrementMarketplaceUsage,
    tryConsumeMarketplaceRun,
} from '../services/marketplaceUsageService.js';

async function loadEntitlements(userId) {
    const row = (
        await pool.query('SELECT plan, trial_ends_at FROM users WHERE id = $1', [userId])
    ).rows[0];
    return getPlanEntitlements(row?.plan ?? 'free', row?.trial_ends_at ?? null);
}

const ACTIVE_JOB_STATUSES = ['queued', 'running'];
const SEARCH_COOLDOWN_SECONDS = 60;
const DEFAULT_LEADS_PER_NICHE = 20;

/** Readable labels for WhatsApp summaries (aligned with scout niche ids). */
const SCOUT_NICHE_LABELS = {
    real_estate: 'Real Estate',
    car_sales: 'Car Sales',
    hr: 'HR / Recruitment',
    second_hand: 'Second-hand / Retail',
};

const formatMarketplaceWhatsAppSummary = ({
    countryLabel,
    nicheCounts,
    totalFound,
    totalSaved,
    saveFailed,
    queriesPreview,
}) => {
    const baseUrl = (process.env.FRONTEND_URL || 'https://www.equipoexperto.com').replace(/\/$/, '');
    const lines = Object.entries(nicheCounts).map(([nicheId, count]) => {
        const label = SCOUT_NICHE_LABELS[nicheId] || nicheId.replace(/_/g, ' ');
        return `• ${label}: ${count}`;
    });
    const nicheBlock =
        lines.length > 0
            ? `\n📂 By group:\n${lines.join('\n')}`
            : '';
    const queryLine = queriesPreview
        ? `\n🔎 Search terms: ${queriesPreview}`
        : '';
    const warn = saveFailed
        ? '\n⚠️ Some leads could not be saved — open the app and check Marketplace.'
        : '';

    return (
        `🔔 *Marketplace lead search finished*\n\n` +
        `🌍 Country: ${countryLabel}\n` +
        `📊 Leads found (this run): *${totalFound}*\n` +
        `💾 New leads saved: *${totalSaved}*${nicheBlock}${queryLine}${warn}\n\n` +
        `View saved leads:\n${baseUrl}/dashboard/marketplace`
    );
};

const sendMarketplaceJobCompletionWhatsApp = async (userId, message) => {
    try {
        const [intRes, cfgRes] = await Promise.all([
            pool.query(
                `SELECT access_token, account_id FROM integrations 
                 WHERE user_id = $1 AND provider = 'whatsapp'`,
                [userId]
            ),
            pool.query(
                `SELECT whatsapp_number_fallback FROM review_funnel_settings WHERE user_id = $1`,
                [userId]
            ),
        ]);

        const int = intRes.rows[0];
        if (!int || int.access_token !== 'whatsapp_native_session') {
            return;
        }

        const fallback = (cfgRes.rows[0]?.whatsapp_number_fallback || '').trim().replace(/\D/g, '');
        const ownerAccount = String(int.account_id || '').trim().replace(/\D/g, '');
        const targetPhone = fallback || ownerAccount;
        if (!targetPhone) {
            console.log('[MarketplaceJob][WA] No owner phone — skip scout summary WhatsApp.');
            return;
        }

        const status = whatsappService.getSessionStatus(userId)?.status;
        if (status !== 'connected') {
            console.log(`[MarketplaceJob][WA] Session not connected (${status}) — skip scout summary.`);
            return;
        }

        await whatsappService.sendWhatsAppMessage(userId, targetPhone, message);
        console.log(`[MarketplaceJob][WA] Scout summary delivered to ${targetPhone}`);
    } catch (e) {
        console.warn('[MarketplaceJob][WA] Scout summary WhatsApp failed:', e.message);
    }
};
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const isGmail = (email = '') => /@gmail\.com$/i.test(String(email || '').trim());
const isWebUrl = (value = '') => /^https?:\/\//i.test(String(value || '').trim());

const collectStrings = (value, list = []) => {
    if (!value) return list;
    if (Array.isArray(value)) {
        value.forEach(item => collectStrings(item, list));
        return list;
    }
    if (typeof value === 'object') {
        Object.values(value).forEach(item => collectStrings(item, list));
        return list;
    }
    list.push(String(value));
    return list;
};

const pickLeadEmail = (lead = {}) => {
    const candidates = new Set();
    const addEmail = (value) => {
        if (!value) return;
        const matches = String(value).match(EMAIL_REGEX);
        if (matches) matches.forEach(match => candidates.add(match.toLowerCase()));
    };
    [lead.email, lead.seller_email, lead.contact_email, lead.emails, lead.contacts, lead.raw_data].forEach(addEmail);
    const emails = Array.from(candidates);
    if (!emails.length) return '';
    const gmail = emails.find(isGmail);
    return gmail || emails[0];
};

const pickLeadWebsite = (lead = {}) => {
    const direct = [lead.website, lead.url, lead.contact_url, lead.contactUrl, lead.webUrl].find(isWebUrl);
    if (direct) return String(direct);
    const pool = collectStrings([lead.website, lead.url, lead.contacts, lead.raw_data]);
    const firstUrl = pool.find(isWebUrl);
    return firstUrl || '';
};

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
    const sourceLabel = typeof lead.source === 'string' && lead.source.toLowerCase().includes('apify')
        ? lead.source.replace(/apify/gi, 'Marketplaces')
        : lead.source;
    const email = pickLeadEmail(lead);
    const website = pickLeadWebsite(lead);
    return {
        id: lead.id,
        first_name: lead.first_name || '',
        last_name: lead.last_name || '',
        full_name: fullName,
        email,
        phone: lead.phone || '',
        title: lead.title || '',
        organization: lead.organization || fullName,
        location: lead.location || '',
        website,
        linkedin_url: lead.linkedin_url || '',
        enrichment_status: lead.enrichment_status || (email || lead.phone || website ? 'found' : 'pending'),
        source: sourceLabel || `Marketplaces - ${niche}`,
        category: niche,
        raw_data: lead.raw_data || lead,
    };
};

const normalizeDedupeDigits = (value) => String(value || '').replace(/\D/g, '').slice(-15);

const canonicalHost = (url = '') => {
    const s = String(url || '').trim();
    if (!s) return '';
    try {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        return u.hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
        return '';
    }
};

/** Collapse duplicate businesses within one Apify response (same place / phone / site). */
const dedupeIncomingRawLeads = (people = []) => {
    const seen = new Set();
    const out = [];
    for (const p of people) {
        const raw = p.raw_data || {};
        const pid =
            (typeof p.id === 'string' && p.id.length > 8 && !/^gmaps_\d+_/.test(p.id) ? p.id : '') ||
            (typeof raw.placeId === 'string' && raw.placeId.length > 8 ? raw.placeId : '');
        const phone = normalizeDedupeDigits(p.phone || p.phoneUnformatted || raw.phone);
        const url = canonicalHost(pickLeadWebsite({ ...p, raw_data: raw }));
        let key = pid ? `pid:${pid}` : '';
        if (!key && phone.length >= 8) key = `ph:${phone}`;
        if (!key && url) key = `url:${url}`;
        if (!key) {
            const name = `${p.organization || ''}|${p.full_name || ''}`.toLowerCase();
            key = `name:${name}`;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
    }
    return out;
};

const marketplacePersistKeys = (storedLead) => {
    const safeLeadId = safeIdentifier(storedLead.id, 'apify');
    const emailKey =
        storedLead.email && storedLead.email.includes('@')
            ? storedLead.email
            : `apify_${safeLeadId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}@placeholder.com`;
    const externalId = safeIdentifier(storedLead.id || emailKey, 'lead');
    return { safeLeadId, emailKey, externalId };
};

const saveStoredMarketplaceLeads = async (client, userId, storedLeadsMapped) => {
    let savedCount = 0;
    let saveFailed = false;
    /** Confirmed persisted rows — used only for job result preview. */
    const insertedLeads = [];

    for (const storedLead of storedLeadsMapped) {
        const cat = storedLead.category || 'general';
        const { emailKey, externalId } = marketplacePersistKeys(storedLead);
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
            const marketInsert = await client.query(
                `INSERT INTO marketplace_leads (
                    user_id, external_id, source, category, title, currency,
                    location, url, description, fetched_at,
                    seller_name, seller_phone, seller_email, contact_url, raw_data
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13,$14
                )
                ON CONFLICT (user_id, external_id) DO NOTHING
                RETURNING id`,
                [
                    userId,
                    externalId,
                    storedLead.source,
                    cat,
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

            if (!marketInsert.rowCount) continue;

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

            savedCount++;
            insertedLeads.push(storedLead);
        } catch (dbError) {
            saveFailed = true;
            console.error('Failed to save marketplace lead:', dbError.message);
        }
    }

    return { savedCount, saveFailed, insertedLeads };
};

const runMarketplaceJob = async ({ jobId, userId, requests, country, requestedLimit, perNicheLimit }) => {
    const client = await pool.connect();
    let totalDiscoveredDeduped = 0;
    const leadsNewToAccount = [];
    let totalSaved = 0;
    let saveFailed = false;
    const nicheCounts = {};
    for (const r of requests) {
        nicheCounts[r.niche] = 0;
    }

    try {
        await client.query(
            `UPDATE marketplace_search_jobs
             SET status = 'running', started_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND user_id = $2`,
            [jobId, userId]
        );

        const existingRes = await client.query(`SELECT external_id FROM marketplace_leads WHERE user_id = $1`, [
            userId,
        ]);
        const existingExternal = new Set(existingRes.rows.map((r) => r.external_id));
        const seenThisJob = new Set();

        let remaining = requestedLimit;
        for (const request of requests) {
            if (remaining <= 0) break;

            const limitForNiche = Math.min(perNicheLimit, remaining);

            const results = await apifyNicheService.scoutByNiche(
                request.niche,
                country,
                request.query,
                { maxResults: limitForNiche }
            );
            const rawBatch = dedupeIncomingRawLeads(results.people || []).slice(0, limitForNiche);
            totalDiscoveredDeduped += rawBatch.length;
            nicheCounts[request.niche] += rawBatch.length;

            const toPersist = [];
            for (const raw of rawBatch) {
                const sl = toStoredLead(raw, request.niche);
                const { externalId } = marketplacePersistKeys(sl);
                if (existingExternal.has(externalId) || seenThisJob.has(externalId)) continue;
                seenThisJob.add(externalId);
                existingExternal.add(externalId);
                toPersist.push(sl);
            }

            remaining -= rawBatch.length;

            const saveResult = await saveStoredMarketplaceLeads(client, userId, toPersist);
            totalSaved += saveResult.savedCount;
            saveFailed = saveFailed || saveResult.saveFailed;
            leadsNewToAccount.push(...(saveResult.insertedLeads || []));
        }

        await incrementMarketplaceUsage(client, userId, totalDiscoveredDeduped);

        try {
            await client.query(
                `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [
                    userId,
                    'Marketplace Lead Search',
                    'scout',
                    saveFailed ? 'attention' : 'success',
                    `Discovered ${totalDiscoveredDeduped} lead(s); ${totalSaved} new saved (${country})`,
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
                totalDiscoveredDeduped,
                totalSaved,
                JSON.stringify({
                    leads: leadsNewToAccount,
                    save_failed: saveFailed,
                    location: country,
                    country,
                    total_found: totalDiscoveredDeduped,
                    saved_count: totalSaved,
                    source: 'Google Maps via Apify',
                }),
            ]
        );

        const queriesPreview = requests
            .map((r) => r.query)
            .filter(Boolean)
            .join(' • ')
            .slice(0, 220);
        const waSummary = formatMarketplaceWhatsAppSummary({
            countryLabel: country,
            nicheCounts,
            totalFound: totalDiscoveredDeduped,
            totalSaved,
            saveFailed,
            queriesPreview: queriesPreview || null,
        });
        setImmediate(() => {
            sendMarketplaceJobCompletionWhatsApp(userId, waSummary);
        });
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
            const entitlements = await loadEntitlements(req.user.id);
            if (!entitlements.apollo_b2b_search) {
                return res.status(403).json({
                    success: false,
                    code: 'PLAN_FEATURE_LOCKED',
                    feature: 'apollo_b2b_search',
                    error: entitlements.trial_active
                        ? 'Apollo people search unlocks after your trial when you subscribe to Growth or Pro.'
                        : 'Apollo people search is available on Growth and Pro.',
                    entitlements,
                });
            }

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
            const { perPage = DEFAULT_LEADS_PER_NICHE, country: bodyCountry } = req.body;
            /** Prefer `country`; keep `location` for older clients mapping to region/country scope. */
            const country = String(bodyCountry ?? req.body.location ?? '').trim();
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

            if (!country) {
                return res.status(400).json({
                    success: false,
                    error: 'Country is required before starting a Marketplace search.'
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
                await client.query('BEGIN');

                const activeJob = await client.query(
                    `SELECT id, status
                     FROM marketplace_search_jobs
                     WHERE user_id = $1 AND status = ANY($2::text[])
                     ORDER BY created_at DESC
                     LIMIT 1`,
                    [userId, ACTIVE_JOB_STATUSES]
                );
                if (activeJob.rows[0]) {
                    await client.query('ROLLBACK');
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
                    await client.query('ROLLBACK');
                    return res.status(429).json({
                        success: false,
                        code: 'MARKETPLACE_COOLDOWN',
                        error: 'Please wait a minute before starting another Marketplace search.',
                    });
                }

                const reserve = await tryConsumeMarketplaceRun(client, userId);
                if (!reserve.ok) {
                    await client.query('ROLLBACK');
                    const snap = reserve.snapshot || (await getUsageSnapshot(pool, userId));
                    if (reserve.code === 'MARKETPLACE_NOT_INCLUDED') {
                        return res.status(403).json({
                            success: false,
                            code: reserve.code,
                            error: snap.trial_active
                                ? 'Marketplace searches are available after your trial ends or when you subscribe. During the trial we keep this feature off to control cost.'
                                : 'Marketplace lead search is available on Starter, Growth, and Pro.',
                            usage: snap,
                        });
                    }
                    return res.status(403).json({
                        success: false,
                        code: reserve.code || 'MARKETPLACE_LIMIT_REACHED',
                        error: snap.runs_limit
                            ? `You have used all ${snap.runs_limit} Marketplace lead searches included in your plan this month (UTC calendar). Upgrade for more searches, or wait until next month.`
                            : 'You have no Marketplace search credits remaining for this period.',
                        usage: snap,
                    });
                }

                const perNicheLimit = Math.max(
                    1,
                    Math.min(Number(perPage) || DEFAULT_LEADS_PER_NICHE, DEFAULT_LEADS_PER_NICHE)
                );
                const requestedLimit = perNicheLimit * requests.length;
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
                        country,
                        requestedLimit,
                        JSON.stringify({ requests }),
                    ]
                );

                await client.query('COMMIT');

                const usage = await getUsageSnapshot(pool, userId);

                setImmediate(() => {
                    runMarketplaceJob({
                        jobId,
                        userId,
                        requests,
                        country,
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
                        credits_reserved: 1,
                        leads_budget_this_run: requestedLimit,
                    },
                });
            } catch (txnErr) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) { /* noop */ }
                throw txnErr;
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

    async getMarketplaceUsage(req, res) {
        try {
            const usage = await getUsageSnapshot(pool, req.user.id);
            return res.json({ success: true, usage });
        } catch (error) {
            console.error('[getMarketplaceUsage]', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to load Marketplace usage.',
            });
        }
    }

    /**
     * Enrich a specific lead to get full contact details
     * POST /api/apollo/enrich
     */
    async enrich(req, res) {
        try {
            const entitlements = await loadEntitlements(req.user.id);
            if (!entitlements.apollo_enrich) {
                return res.status(403).json({
                    success: false,
                    code: 'PLAN_FEATURE_LOCKED',
                    feature: 'apollo_enrich',
                    error: entitlements.trial_active
                        ? 'Contact enrichment unlocks after your trial on a Pro subscription.'
                        : 'Contact enrichment is available on Pro.',
                    entitlements,
                });
            }

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
            const entitlements = await loadEntitlements(req.user.id);
            if (!entitlements.apollo_b2b_search) {
                return res.status(403).json({
                    success: false,
                    code: 'PLAN_FEATURE_LOCKED',
                    feature: 'apollo_b2b_search',
                    error: 'This diagnostic is restricted to Growth and Pro accounts.',
                    entitlements,
                });
            }

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
