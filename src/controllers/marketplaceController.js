/**
 * marketplaceController.js
 * All 9 marketplaces are scraped via Apify — n8n is no longer
 * used for marketplace data so the flow stays fully internal.
 */

import pool from '../db/pool.js';
import { runApifyScraper } from '../services/apifyService.js';

// Whitelist — only these IDs are accepted from the client
const ALLOWED = new Set([
    'idealista', 'fotocasa', 'pisos',
    'coches_net', 'autoscout',
    'infojobs',
    'wallapop', 'vinted',
]);

const DISPLAY_NAMES = {
    idealista:  'Idealista',
    fotocasa:   'Fotocasa',
    pisos:      'Pisos.com',
    coches_net: 'Coches.net',
    autoscout:  'AutoScout24',
    infojobs:   'InfoJobs',
    wallapop:   'Wallapop',
    vinted:     'Vinted',
};

// ── POST /api/marketplace/fetch ────────────────────────────────────────────

export const fetchMarketplaceLeads = async (req, res) => {
    const userId = req.user.id;
    const { marketplaces } = req.body;

    if (!Array.isArray(marketplaces) || marketplaces.length === 0) {
        return res.status(400).json({ success: false, message: 'Select at least one marketplace.' });
    }

    // Server-side whitelist — never trust client-supplied IDs blindly
    const invalid = marketplaces.filter(id => !ALLOWED.has(id));
    if (invalid.length) {
        return res.status(400).json({ success: false, message: `Unknown marketplace(s): ${invalid.join(', ')}` });
    }

    // Run all scrapers in parallel; individual failures don't abort the whole request
    const tasks = marketplaces.map(async (id) => {
        try {
            const leads = await runApifyScraper(id);
            console.log(`[Marketplace] ${id} → ${leads.length} leads`);
            return { marketplace: id, leads, count: leads.length };
        } catch (err) {
            console.error(`[Marketplace] ${id} failed:`, err.message);
            return { marketplace: id, leads: [], error: err.message };
        }
    });

    const results = await Promise.allSettled(tasks);

    let allLeads = [];
    const errors  = [];

    results.forEach((result, i) => {
        const id = marketplaces[i];
        if (result.status === 'fulfilled') {
            const { leads, error } = result.value;
            if (error && leads.length === 0) {
                errors.push({ marketplace: DISPLAY_NAMES[id] || id, error });
            } else {
                allLeads = allLeads.concat(leads);
            }
        } else {
            errors.push({ marketplace: DISPLAY_NAMES[id] || id, error: result.reason?.message || 'Unknown error' });
        }
    });

    const summary = {};
    marketplaces.forEach(id => {
        summary[DISPLAY_NAMES[id] || id] = allLeads.filter(l => l.source === id).length;
    });

    return res.json({
        success: true,
        leads:  allLeads,
        count:  allLeads.length,
        marketplaces,
        summary,
        errors: errors.length ? errors : undefined,
    });
};

// ── POST /api/marketplace/store ────────────────────────────────────────────

export const storeMarketplaceLeads = async (req, res) => {
    const userId = req.user.id;
    const { leads } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
        return res.status(400).json({ success: false, message: 'No leads to store.' });
    }

    const client = await pool.connect();
    let stored = 0, duplicates = 0;

    try {
        await client.query('BEGIN');

        for (const lead of leads) {
            const extId = String(lead.id || '');

            const dup = await client.query(
                `SELECT id FROM marketplace_leads
                 WHERE user_id = $1 AND (external_id = $2 OR (url IS NOT NULL AND url = $3))`,
                [userId, extId, lead.url || null]
            );
            if (dup.rows.length) { duplicates++; continue; }

            await client.query(
                `INSERT INTO marketplace_leads (
                    user_id, external_id, source, category, title, price, currency,
                    location, url, image_url, description, fetched_at,
                    size, rooms, floor, agency, brand, model, year, mileage, fuel,
                    company, salary, contract_type, is_remote,
                    seller_name, seller_phone, seller_email, contact_url, raw_data
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                    $13,$14,$15,$16,$17,$18,$19,$20,$21,
                    $22,$23,$24,$25,
                    $26,$27,$28,$29,$30
                )`,
                [
                    userId, extId,
                    lead.source,   lead.category, lead.title,
                    lead.price     ? parseFloat(lead.price)  : null,
                    lead.currency  || 'EUR',
                    lead.location, lead.url,
                    lead.image,    lead.description,
                    lead.fetchedAt || new Date(),
                    lead.size      ? parseFloat(lead.size)   : null,
                    lead.rooms     ? parseInt(lead.rooms)    : null,
                    lead.floor     || null,
                    lead.agency    || null,
                    lead.brand     || null, lead.model    || null,
                    lead.year      ? parseInt(lead.year)     : null,
                    lead.mileage   ? parseFloat(lead.mileage): null,
                    lead.fuel      || null,
                    lead.company   || null,
                    lead.salary    || null,
                    lead.contract  || null,
                    lead.remote    || false,
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
        console.error('[storeMarketplaceLeads]', err.message);
        return res.status(500).json({ success: false, message: 'Failed to store leads.' });
    } finally {
        client.release();
    }
};

// ── GET /api/marketplace/leads ─────────────────────────────────────────────

export const getStoredLeads = async (req, res) => {
    const userId = req.user.id;
    const { category, source, limit = 50, offset = 0 } = req.query;
    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 500));
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    try {
        const params  = [userId];
        let   where   = 'WHERE user_id = $1';
        let   idx     = 2;

        if (category) { where += ` AND category = $${idx++}`; params.push(category); }
        if (source)   { where += ` AND source   = $${idx++}`; params.push(source);   }

        const [rows, count] = await Promise.all([
            pool.query(
                `SELECT id, external_id, source, category, title, price, currency,
                        location, url, image_url, description, fetched_at, created_at,
                        size, rooms, floor, agency, brand, model, year, mileage, fuel,
                        company, salary, contract_type, is_remote,
                        seller_name, seller_phone, seller_email, contact_url, raw_data
                 FROM marketplace_leads ${where}
                 ORDER BY fetched_at DESC
                 LIMIT $${idx} OFFSET $${idx + 1}`,
                [...params, safeLimit, safeOffset]
            ),
            pool.query(`SELECT COUNT(*) FROM marketplace_leads ${where}`, params),
        ]);

        const leads = rows.rows.map(r => ({
            id:           r.external_id,
            source:       r.source,
            category:     r.category,
            full_name:    r.seller_name || r.title,
            email:        r.seller_email,
            phone:        r.seller_phone,
            notes:        r.raw_data?.notes || r.raw_data || {},
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

        return res.json({
            success: true, leads,
            total: parseInt(count.rows[0].count),
            limit: safeLimit, offset: safeOffset,
        });

    } catch (err) {
        console.error('[getStoredLeads]', err.message);
        return res.status(500).json({ success: false, message: 'Failed to retrieve leads.' });
    }
};

// ── DELETE /api/marketplace/leads/:id ─────────────────────────────────────

export const deleteLead = async (req, res) => {
    const userId = req.user.id;
    const { id }  = req.params;
    try {
        const r = await pool.query(
            'DELETE FROM marketplace_leads WHERE user_id = $1 AND external_id = $2 RETURNING id',
            [userId, id]
        );
        if (!r.rowCount) return res.status(404).json({ success: false, message: 'Lead not found.' });
        return res.json({ success: true });
    } catch (err) {
        console.error('[deleteLead]', err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete lead.' });
    }
};

// ── DELETE /api/marketplace/leads ─────────────────────────────────────────

export const deleteAllLeads = async (req, res) => {
    const userId = req.user.id;
    try {
        const r = await pool.query('DELETE FROM marketplace_leads WHERE user_id = $1 RETURNING id', [userId]);
        return res.json({ success: true, deletedCount: r.rowCount, message: `${r.rowCount} leads deleted.` });
    } catch (err) {
        console.error('[deleteAllLeads]', err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete leads.' });
    }
};
