import fetch from 'node-fetch';

const APIFY_BASE = 'https://api.apify.com/v2';
const TOKEN = process.env.APIFY_API_TOKEN;

// Actor IDs for each marketplace
const ACTORS = {
    idealista:  'misceres/idealista-scraper',
    autoscout:  'epctex/autoscout24-scraper',
};

// Default search inputs per marketplace
const DEFAULT_INPUTS = {
    idealista: {
        startUrls: [{ url: 'https://www.idealista.com/venta-viviendas/madrid-madrid/' }],
        maxItems: 25,
        proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    },
    autoscout: {
        startUrls: [{ url: 'https://www.autoscout24.es/lst' }],
        maxResults: 25,
        proxy: { useApifyProxy: true },
    },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Start an Apify actor run and wait for it to finish (poll-based).
 * Returns normalized lead array with contact info.
 */
export const runApifyScraper = async (marketplaceId, customInput = {}) => {
    if (!TOKEN) throw new Error('APIFY_API_TOKEN not set');

    const actorId = ACTORS[marketplaceId];
    if (!actorId) throw new Error(`No Apify actor configured for: ${marketplaceId}`);

    const input = { ...DEFAULT_INPUTS[marketplaceId], ...customInput };

    // 1. Start run
    const startRes = await fetch(
        `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/runs?token=${TOKEN}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        }
    );
    if (!startRes.ok) {
        const err = await startRes.text();
        throw new Error(`Failed to start Apify actor (${startRes.status}): ${err}`);
    }
    const { data: runData } = await startRes.json();
    const runId = runData.id;
    const datasetId = runData.defaultDatasetId;
    console.log(`[Apify] ▶ ${marketplaceId} run started: ${runId}`);

    // 2. Poll until finished (max 5 min)
    const POLL_INTERVAL = 8000;
    const MAX_WAIT = 5 * 60 * 1000;
    const deadline = Date.now() + MAX_WAIT;

    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL);
        const statusRes = await fetch(
            `${APIFY_BASE}/actor-runs/${runId}?token=${TOKEN}`
        );
        if (!statusRes.ok) continue;
        const { data: runStatus } = await statusRes.json();
        const status = runStatus.status;
        console.log(`[Apify] ${marketplaceId} run ${runId} status: ${status}`);

        if (status === 'SUCCEEDED') break;
        if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
            throw new Error(`Apify run ${status} for ${marketplaceId}`);
        }
    }

    // 3. Fetch dataset items
    const dataRes = await fetch(
        `${APIFY_BASE}/datasets/${datasetId}/items?token=${TOKEN}&clean=true&limit=100`
    );
    if (!dataRes.ok) throw new Error(`Failed to fetch dataset (${dataRes.status})`);
    const items = await dataRes.json();

    console.log(`[Apify] ${marketplaceId} — ${items.length} items fetched from dataset`);
    return normalizeItems(marketplaceId, items);
};

// ── Normalizers per marketplace ────────────────────────────────────────────

const normalizeItems = (marketplaceId, items) => {
    switch (marketplaceId) {
        case 'idealista':  return items.map(normalizeIdealista);
        case 'autoscout':  return items.map(normalizeAutoscout);
        default:           return items;
    }
};

const normalizeIdealista = (item) => ({
    id:           item.propertyCode || item.id || `id_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
    source:       'idealista',
    category:     'real_estate',
    title:        item.suggestedTexts?.subtitle || item.title || item.description?.substring(0, 80) || 'Property',
    price:        item.price ?? null,
    currency:     'EUR',
    location:     [item.district, item.municipality, item.province].filter(Boolean).join(', ') || item.address || null,
    url:          item.url ? `https://www.idealista.com${item.url}` : null,
    image:        item.thumbnail || (item.multimedia?.images?.[0]?.url) || null,
    description:  item.description || null,
    fetchedAt:    new Date().toISOString(),
    // property fields
    size:         item.size ?? null,
    rooms:        item.rooms ?? null,
    floor:        item.floor?.toString() ?? null,
    // contact fields — key addition
    seller_name:  item.agencyName || item.contactInfo?.agencyName || item.suggestedTexts?.title || null,
    seller_phone: extractPhone(item.contactInfo?.phone1 || item.phone || item.contactInfo?.phones),
    seller_email: item.contactInfo?.email || item.email || null,
    contact_url:  item.contactInfo?.url || null,
    rawData:      item,
});

const normalizeAutoscout = (item) => ({
    id:           item.id || item.vehicleId || `as_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
    source:       'autoscout',
    category:     'vehicles',
    title:        [item.make, item.model, item.version].filter(Boolean).join(' ') || item.title || 'Vehicle',
    price:        item.price?.value ?? item.price ?? null,
    currency:     item.price?.currency || 'EUR',
    location:     [item.location?.city, item.location?.country].filter(Boolean).join(', ') || null,
    url:          item.url || null,
    image:        item.images?.[0] || item.image || null,
    description:  item.description || null,
    fetchedAt:    new Date().toISOString(),
    // vehicle fields
    brand:        item.make || item.brand || null,
    model:        item.model || null,
    year:         item.firstRegistration ? parseInt(item.firstRegistration) : (item.year ?? null),
    mileage:      item.mileage?.value ?? item.mileage ?? null,
    fuel:         item.fuel || item.fuelType || null,
    // contact fields
    seller_name:  item.seller?.name || item.dealer?.name || item.sellerName || null,
    seller_phone: extractPhone(item.seller?.phone || item.dealer?.phone || item.phone),
    seller_email: item.seller?.email || item.dealer?.email || item.email || null,
    contact_url:  item.seller?.url || item.dealer?.url || null,
    rawData:      item,
});

// Handles phone as string, array, or object
const extractPhone = (phone) => {
    if (!phone) return null;
    if (typeof phone === 'string') return phone.trim() || null;
    if (Array.isArray(phone)) return phone[0]?.toString().trim() || null;
    if (typeof phone === 'object') return phone.number || phone.value || phone.phone || null;
    return String(phone).trim() || null;
};
