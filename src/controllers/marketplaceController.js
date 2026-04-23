import pool from '../db/pool.js';
import fetch from 'node-fetch';
import { runApifyScraper } from '../services/apifyService.js';

// Marketplaces handled by Apify (direct, with contact info)
const APIFY_MARKETPLACES = new Set(['idealista', 'autoscout']);

// Remaining marketplaces still using n8n webhooks
const N8N_WEBHOOK_URLS = {
    coches_net: process.env.N8N_MARKETPLACE_COCHES_WEBHOOK    || 'https://n8n.srv882475.hstgr.cloud/webhook/marketplace-Coches.net',
    fotocasa:   process.env.N8N_MARKETPLACE_FOTOCASA_WEBHOOK   || 'https://n8n.srv882475.hstgr.cloud/webhook/marketplace-Fotocasa',
    infojobs:   process.env.N8N_MARKETPLACE_INFOJOBS_WEBHOOK   || 'https://n8n.srv882475.hstgr.cloud/webhook/marketplace-InfoJobs',
    wallapop:   process.env.N8N_MARKETPLACE_WALLAPOP_WEBHOOK   || 'https://n8n.srv882475.hstgr.cloud/webhook/marketplace-Wallapop',
    vinted:     process.env.N8N_MARKETPLACE_VINTED_WEBHOOK     || 'https://n8n.srv882475.hstgr.cloud/webhook/marketplace-Vinted',
};

const ALLOWED_MARKETPLACES = new Set([...APIFY_MARKETPLACES, ...Object.keys(N8N_WEBHOOK_URLS)]);

const formatMarketplaceName = (id) => ({
    idealista:  'Idealista',
    coches_net: 'Coches.net',
    fotocasa:   'Fotocasa',
    autoscout:  'AutoScout24',
    infojobs:   'InfoJobs',
    wallapop:   'Wallapop',
    vinted:     'Vinted',
}[id] || id);

// ── Fetch via Apify ────────────────────────────────────────────────────────

const fetchViaApify = async (marketplaceId, userId) => {
    console.log(`[Marketplace] Apify fetch → ${marketplaceId}`);
    const leads = await runApifyScraper(marketplaceId);
    return { marketplace: marketplaceId, leads, count: leads.length };
};

// ── Fetch via n8n webhook ──────────────────────────────────────────────────

const fetchViaN8n = async (marketplaceId, userId) => {
    const webhookUrl = N8N_WEBHOOK_URLS[marketplaceId];
    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace: marketplaceId, userId, requestId: `${userId}_${Date.now()}_${marketplaceId}` }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    let leads = [];
    if (Array.isArray(data))                          leads = data;
    else if (Array.isArray(data.items))               leads = data.items.map(i => i.json || i);
    else if (Array.isArray(data.data))                leads = data.data;
    else if (Array.isArray(data.leads))               leads = data.leads;
    else if (Array.isArray(data.body))                leads = data.body;
    else if (typeof data === 'object' && data !== null) leads = [data];

    leads = leads.filter(l => l && typeof l === 'object').map(l => l.json && typeof l.json === 'object' ? l.json : l);
    return { marketplace: marketplaceId, leads, count: leads.length };
};

// ── Normalize leads from n8n (Apify leads are already normalized) ──────────

const normalizeN8nLead = (lead, marketplaceId) => ({
    id:           lead.id || lead.A || `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    source:       lead.source || lead.B || marketplaceId,
    category:     lead.category || lead.C || 'general',
    title:        lead.title || lead.D || 'Untitled',
    price:        lead.price || lead.E || null,
    currency:     lead.currency || lead.F || 'EUR',
    location:     lead.location || lead.G || null,
    url:          lead.url || lead.H || null,
    image:        lead.image || lead.I || null,
    description:  lead.description || lead.J || null,
    fetchedAt:    lead.fetchedAt || lead.K || new Date().toISOString(),
    size:         lead.size || lead.L || null,
    rooms:        lead.rooms || lead.M || null,
    floor:        lead.floor || lead.N || null,
    agency:       lead.agency || lead.O || null,
    brand:        lead.brand || lead.P || null,
    model:        lead.model || lead.Q || null,
    year:         lead.year || lead.R || null,
    mileage:      lead.mileage || lead.S || null,
    fuel:         lead.fuel || lead.T || null,
    company:      lead.company || lead.U || null,
    salary:       lead.salary || lead.V || null,
    contract:     lead.contract || lead.W || null,
    remote:       lead.remote || lead.X || false,
    seller_name:  null,
    seller_phone: null,
    seller_email: null,
    contact_url:  null,
    rawData:      lead,
});

// ── POST /api/marketplace/fetch ────────────────────────────────────────────

export const fetchMarketplaceLeads = async (req, res) => {
    const userId = req.user.id;
    const { marketplaces } = req.body;

    if (!Array.isArray(marketplaces) || marketplaces.length === 0) {
        return res.status(400).json({ success: false, message: 'Please select at least one marketplace' });
    }

    // Whitelist check — never trust client-provided IDs directly
    const invalid = marketplaces.filter(id => !ALLOWED_MARKETPLACES.has(id));
    if (invalid.length > 0) {
        return res.status(400).json({ success: false, message: `Unknown marketplace(s): ${invalid.join(', ')}` });
    }

    try {
        const tasks = marketplaces.map(async (id) => {
            try {
                if (APIFY_MARKETPLACES.has(id)) {
                    return await fetchViaApify(id, userId);
                }
                return await fetchViaN8n(id, userId);
            } catch (err) {
                console.error(`[Marketplace] fetch error for ${id}:`, err.message);
                return { marketplace: id, leads: [], error: err.message };
            }
        });

        const results = await Promise.allSettled(tasks);

        let allLeads = [];
        const errors = [];

        results.forEach((result, i) => {
            const id = marketplaces[i];
            if (result.status === 'fulfilled') {
                const { leads, error } = result.value;
                if (error && leads.length === 0) {
                    errors.push({ marketplace: formatMarketplaceName(id), error });
                } else {
                    // Apify leads are already normalized with contact info; n8n leads need normalization
                    const normalized = leads.map(l =>
                        APIFY_MARKETPLACES.has(id) ? { ...l, source: l.source || id } : normalizeN8nLead(l, id)
                    );
                    allLeads = allLeads.concat(normalized);
                }
            } else {
                errors.push({ marketplace: formatMarketplaceName(id), error: result.reason?.message || 'Failed' });
            }
        });

        const summary = {};
        marketplaces.forEach(id => {
            summary[formatMarketplaceName(id)] = allLeads.filter(l =>
                (l.source || '').toLowerCase() === id.toLowerCase()
            ).length;
        });

        return res.json({
            success: true,
            leads: allLeads,
            count: allLeads.length,
            marketplaces,
            summary,
            errors: errors.length > 0 ? errors : undefined,
        });

    } catch (err) {
        console.error('[fetchMarketplaceLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch marketplace leads.' });
    }
};

// ── POST /api/marketplace/store ────────────────────────────────────────────

export const storeMarketplaceLeads = async (req, res) => {
    const userId = req.user.id;
    const { leads } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
        return res.status(400).json({ success: false, message: 'No leads to store' });
    }

    const client = await pool.connect();
    let stored = 0;
    let duplicates = 0;

    try {
        await client.query('BEGIN');

        for (const lead of leads) {
            const existing = await client.query(
                'SELECT id FROM marketplace_leads WHERE user_id = $1 AND (external_id = $2 OR (url IS NOT NULL AND url = $3))',
                [userId, String(lead.id || ''), lead.url || null]
            );
            if (existing.rows.length > 0) { duplicates++; continue; }

            await client.query(
                `INSERT INTO marketplace_leads (
                    user_id, external_id, source, category, title, price, currency,
                    location, url, image_url, description, fetched_at,
                    size, rooms, floor, agency, brand, model, year, mileage, fuel,
                    company, salary, contract_type, is_remote,
                    seller_name, seller_phone, seller_email, contact_url,
                    raw_data
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
                [
                    userId,
                    String(lead.id || ''),
                    lead.source,
                    lead.category,
                    lead.title,
                    lead.price    ? parseFloat(lead.price)    : null,
                    lead.currency || 'EUR',
                    lead.location,
                    lead.url,
                    lead.image,
                    lead.description,
                    lead.fetchedAt || new Date(),
                    lead.size     ? parseFloat(lead.size)     : null,
                    lead.rooms    ? parseInt(lead.rooms)       : null,
                    lead.floor,
                    lead.agency,
                    lead.brand,
                    lead.model,
                    lead.year     ? parseInt(lead.year)        : null,
                    lead.mileage  ? parseFloat(lead.mileage)   : null,
                    lead.fuel,
                    lead.company,
                    lead.salary,
                    lead.contract,
                    lead.remote || false,
                    lead.seller_name  || null,
                    lead.seller_phone || null,
                    lead.seller_email || null,
                    lead.contact_url  || null,
                    JSON.stringify(lead.rawData || lead),
                ]
            );
            stored++;
        }

        await client.query('COMMIT');
        return res.json({ success: true, stored, duplicates, total: leads.length });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[storeMarketplaceLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to store leads' });
    } finally {
        client.release();
    }
};

// ── GET /api/marketplace/leads ─────────────────────────────────────────────

export const getStoredLeads = async (req, res) => {
    const userId = req.user.id;
    const { category, source, limit = 50, offset = 0 } = req.query;

    try {
        let query = `
            SELECT id, external_id, source, category, title, price, currency,
                   location, url, image_url, description, fetched_at, created_at,
                   size, rooms, floor, agency, brand, model, year, mileage, fuel,
                   company, salary, contract_type, is_remote,
                   seller_name, seller_phone, seller_email, contact_url
            FROM marketplace_leads
            WHERE user_id = $1`;
        const params = [userId];
        let idx = 2;

        if (category) { query += ` AND category = $${idx++}`; params.push(category); }
        if (source)   { query += ` AND source   = $${idx++}`; params.push(source); }

        query += ` ORDER BY fetched_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const [result, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query('SELECT COUNT(*) FROM marketplace_leads WHERE user_id = $1', [userId]),
        ]);

        const leads = result.rows.map(r => ({
            id:           r.external_id,
            source:       r.source,
            category:     r.category,
            title:        r.title,
            price:        r.price,
            currency:     r.currency,
            location:     r.location,
            url:          r.url,
            image:        r.image_url,
            description:  r.description,
            fetchedAt:    r.fetched_at,
            size:         r.size,
            rooms:        r.rooms,
            floor:        r.floor,
            agency:       r.agency,
            brand:        r.brand,
            model:        r.model,
            year:         r.year,
            mileage:      r.mileage,
            fuel:         r.fuel,
            company:      r.company,
            salary:       r.salary,
            contract:     r.contract_type,
            remote:       r.is_remote,
            seller_name:  r.seller_name,
            seller_phone: r.seller_phone,
            seller_email: r.seller_email,
            contact_url:  r.contact_url,
        }));

        return res.json({ success: true, leads, total: parseInt(countResult.rows[0].count), limit: parseInt(limit), offset: parseInt(offset) });

    } catch (err) {
        console.error('[getStoredLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to retrieve leads' });
    }
};

// ── DELETE /api/marketplace/leads/:id ─────────────────────────────────────

export const deleteLead = async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;

    try {
        const result = await pool.query(
            'DELETE FROM marketplace_leads WHERE user_id = $1 AND external_id = $2 RETURNING id',
            [userId, id]
        );
        if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Lead not found' });
        return res.json({ success: true, message: 'Lead deleted' });
    } catch (err) {
        console.error('[deleteLead] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete lead' });
    }
};

// ── DELETE /api/marketplace/leads ─────────────────────────────────────────

export const deleteAllLeads = async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await pool.query('DELETE FROM marketplace_leads WHERE user_id = $1 RETURNING id', [userId]);
        return res.json({ success: true, message: `${result.rowCount} leads deleted`, deletedCount: result.rowCount });
    } catch (err) {
        console.error('[deleteAllLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete all leads' });
    }
};
