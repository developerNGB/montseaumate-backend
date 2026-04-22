/**
 * Marketplace Controller
 * Handles fetching and storing marketplace leads from N8N webhook
 */

import pool from '../db/pool.js';
import fetch from 'node-fetch';

const WEBHOOK_URL = 'https://n8n.srv882475.hstgr.cloud/webhook-test/marketplace-leads';

/**
 * POST /api/marketplace/fetch
 * Fetches leads from N8N webhook for selected marketplaces
 */
export const fetchMarketplaceLeads = async (req, res) => {
    const userId = req.user.id;
    const { marketplaces } = req.body;

    if (!marketplaces || !Array.isArray(marketplaces) || marketplaces.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Please select at least one marketplace'
        });
    }

    try {
        // Call N8N webhook with marketplace selection
        const webhookRes = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                marketplaces,
                userId,
                requestId: `${userId}_${Date.now()}`
            })
        });

        if (!webhookRes.ok) {
            throw new Error(`Webhook returned ${webhookRes.status}`);
        }

        const data = await webhookRes.json();

        // N8N returns data in various formats - handle both array and object responses
        let leads = [];
        if (Array.isArray(data)) {
            leads = data;
        } else if (data.data && Array.isArray(data.data)) {
            leads = data.data;
        } else if (data.leads && Array.isArray(data.leads)) {
            leads = data.leads;
        } else if (typeof data === 'object' && data !== null) {
            // Single lead object
            leads = [data];
        }

        // Normalize lead data structure
        const normalizedLeads = leads.map(lead => ({
            id: lead.id || lead.A || `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            source: lead.source || lead.B || 'unknown',
            category: lead.category || lead.C || 'general',
            title: lead.title || lead.D || 'Untitled',
            price: lead.price || lead.E || null,
            currency: lead.currency || lead.F || 'EUR',
            location: lead.location || lead.G || null,
            url: lead.url || lead.H || null,
            image: lead.image || lead.I || null,
            description: lead.description || lead.J || null,
            fetchedAt: lead.fetchedAt || lead.K || new Date().toISOString(),
            // Real estate fields
            size: lead.size || lead.L || null,
            rooms: lead.rooms || lead.M || null,
            floor: lead.floor || lead.N || null,
            // Vehicle fields
            agency: lead.agency || lead.O || null,
            brand: lead.brand || lead.P || null,
            model: lead.model || lead.Q || null,
            year: lead.year || lead.R || null,
            mileage: lead.mileage || lead.S || null,
            fuel: lead.fuel || lead.T || null,
            // Job fields
            company: lead.company || lead.U || null,
            salary: lead.salary || lead.V || null,
            contract: lead.contract || lead.W || null,
            remote: lead.remote || lead.X || false,
            // Metadata
            rawData: lead
        }));

        return res.json({
            success: true,
            leads: normalizedLeads,
            count: normalizedLeads.length,
            marketplaces
        });

    } catch (err) {
        console.error('[fetchMarketplaceLeads] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch marketplace leads. Please try again.'
        });
    }
};

/**
 * POST /api/marketplace/store
 * Stores fetched leads to database
 */
export const storeMarketplaceLeads = async (req, res) => {
    const userId = req.user.id;
    const { leads } = req.body;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'No leads to store'
        });
    }

    const client = await pool.connect();
    let stored = 0;
    let duplicates = 0;

    try {
        await client.query('BEGIN');

        for (const lead of leads) {
            // Check for duplicates by URL or external ID
            const existing = await client.query(
                'SELECT id FROM marketplace_leads WHERE user_id = $1 AND (external_id = $2 OR url = $3)',
                [userId, lead.id, lead.url]
            );

            if (existing.rows.length > 0) {
                duplicates++;
                continue;
            }

            // Insert new lead
            await client.query(
                `INSERT INTO marketplace_leads (
                    user_id, external_id, source, category, title, price, currency,
                    location, url, image_url, description, fetched_at,
                    size, rooms, floor, agency, brand, model, year, mileage, fuel,
                    company, salary, contract_type, is_remote, raw_data
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
                [
                    userId,
                    lead.id,
                    lead.source,
                    lead.category,
                    lead.title,
                    lead.price ? parseFloat(lead.price) : null,
                    lead.currency,
                    lead.location,
                    lead.url,
                    lead.image,
                    lead.description,
                    lead.fetchedAt || new Date(),
                    lead.size ? parseFloat(lead.size) : null,
                    lead.rooms ? parseInt(lead.rooms) : null,
                    lead.floor,
                    lead.agency,
                    lead.brand,
                    lead.model,
                    lead.year ? parseInt(lead.year) : null,
                    lead.mileage ? parseFloat(lead.mileage) : null,
                    lead.fuel,
                    lead.company,
                    lead.salary,
                    lead.contract,
                    lead.remote || false,
                    JSON.stringify(lead.rawData || lead)
                ]
            );
            stored++;
        }

        await client.query('COMMIT');

        return res.json({
            success: true,
            stored,
            duplicates,
            total: leads.length
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[storeMarketplaceLeads] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to store leads'
        });
    } finally {
        client.release();
    }
};

/**
 * GET /api/marketplace/leads
 * Get stored marketplace leads for user
 */
export const getStoredLeads = async (req, res) => {
    const userId = req.user.id;
    const { category, source, limit = 50, offset = 0 } = req.query;

    try {
        let query = `
            SELECT 
                id, external_id, source, category, title, price, currency,
                location, url, image_url, description, fetched_at, created_at,
                size, rooms, floor, agency, brand, model, year, mileage, fuel,
                company, salary, contract_type, is_remote
            FROM marketplace_leads 
            WHERE user_id = $1
        `;
        const params = [userId];
        let paramIdx = 2;

        if (category) {
            query += ` AND category = $${paramIdx}`;
            params.push(category);
            paramIdx++;
        }

        if (source) {
            query += ` AND source = $${paramIdx}`;
            params.push(source);
            paramIdx++;
        }

        query += ` ORDER BY fetched_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        // Get total count
        const countResult = await pool.query(
            'SELECT COUNT(*) FROM marketplace_leads WHERE user_id = $1',
            [userId]
        );

        // Normalize to frontend format
        const leads = result.rows.map(row => ({
            id: row.external_id,
            A: row.external_id,
            source: row.source,
            B: row.source,
            category: row.category,
            C: row.category,
            title: row.title,
            D: row.title,
            price: row.price,
            E: row.price,
            currency: row.currency,
            F: row.currency,
            location: row.location,
            G: row.location,
            url: row.url,
            H: row.url,
            image: row.image_url,
            I: row.image_url,
            description: row.description,
            J: row.description,
            fetchedAt: row.fetched_at,
            K: row.fetched_at,
            size: row.size,
            L: row.size,
            rooms: row.rooms,
            M: row.rooms,
            floor: row.floor,
            N: row.floor,
            agency: row.agency,
            O: row.agency,
            brand: row.brand,
            P: row.brand,
            model: row.model,
            Q: row.model,
            year: row.year,
            R: row.year,
            mileage: row.mileage,
            S: row.mileage,
            fuel: row.fuel,
            T: row.fuel,
            company: row.company,
            U: row.company,
            salary: row.salary,
            V: row.salary,
            contract: row.contract_type,
            W: row.contract_type,
            remote: row.is_remote,
            X: row.is_remote,
        }));

        return res.json({
            success: true,
            leads,
            total: parseInt(countResult.rows[0].count),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

    } catch (err) {
        console.error('[getStoredLeads] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve leads'
        });
    }
};

/**
 * DELETE /api/marketplace/leads/:id
 * Delete a stored lead
 */
export const deleteLead = async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;

    try {
        const result = await pool.query(
            'DELETE FROM marketplace_leads WHERE user_id = $1 AND external_id = $2 RETURNING id',
            [userId, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }

        return res.json({
            success: true,
            message: 'Lead deleted'
        });

    } catch (err) {
        console.error('[deleteLead] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete lead'
        });
    }
};
