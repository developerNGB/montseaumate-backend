/**
 * apifyService.js
 * ────────────────────────────────────────────────────────────
 * All marketplace scraping runs through Apify actors.
 * Actor IDs are overridable via environment variables so a
 * replacement actor can be swapped without a code deploy.
 *
 * Contact-info availability by platform:
 *   Real estate (Idealista, Fotocasa, Pisos.com) → phone ✓
 *   Cars        (Coches.net, AutoScout24)         → phone ✓
 *   Jobs        (InfoJobs)                        → company name ✓, email rare
 *   P2P         (Wallapop, Vinted)                → contact_url only (no direct phone/email)
 *
 * Verified actor IDs (April 2026) — all confirmed live on Apify Store:
 *   crawlerbros/idealista-scraper · gio21/fotocasa-scraper · gio21/pisos-scraper
 *   ivanvs/coches-net-scraper · ivanvs/autoscout-scraper · crawlerbros/infojobs-scraper
 *   igolaizola/wallapop-scraper · automation-lab/vinted-scraper
 */

import fetch from 'node-fetch';

const APIFY_BASE = 'https://api.apify.com/v2';
const POLL_MS    = 8_000;          // poll interval
const MAX_MS     = 8 * 60_000;     // 8-minute hard cap per actor run
const ITEMS_CAP  = 50;             // max items fetched from dataset

// ── Actor registry ────────────────────────────────────────────────────────
// Each ID can be overridden via process.env so ops can swap without redeploy.
const ACTOR_IDS = {
    idealista:  process.env.APIFY_ACTOR_IDEALISTA  || 'crawlerbros/idealista-scraper',
    fotocasa:   process.env.APIFY_ACTOR_FOTOCASA   || 'gio21/fotocasa-scraper',
    pisos:      process.env.APIFY_ACTOR_PISOS      || 'gio21/pisos-scraper',
    coches_net: process.env.APIFY_ACTOR_COCHES     || 'ivanvs/coches-net-scraper',
    autoscout:  process.env.APIFY_ACTOR_AUTOSCOUT  || 'ivanvs/autoscout-scraper',
    infojobs:   process.env.APIFY_ACTOR_INFOJOBS   || 'crawlerbros/infojobs-scraper',
    wallapop:   process.env.APIFY_ACTOR_WALLAPOP   || 'igolaizola/wallapop-scraper',
    vinted:     process.env.APIFY_ACTOR_VINTED     || 'automation-lab/vinted-scraper',
};

// ── Default actor inputs ──────────────────────────────────────────────────
// Field names match each actor's documented input schema.
const DEFAULT_INPUTS = {
    idealista: {
        location:         'madrid-madrid',
        operation:        'sale',
        propertyType:     'homes',
        country:          'es',
        maximumProperties: 25,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    },
    fotocasa: {
        operation:    'comprar',
        propertyType: 'viviendas',
        location:     'madrid-capital',
        maxItems:     25,
        maxPages:     3,
    },
    pisos: {
        operation:    'venta',
        propertyType: 'pisos',
        location:     'madrid',
        maxItems:     25,
        maxPages:     3,
    },
    coches_net: {
        urls:       [{ url: 'https://www.coches.net/segunda-mano/' }],
        maxRecords: 25,
    },
    autoscout: {
        urls:       [{ url: 'https://www.autoscout24.es/lst' }],
        maxRecords: 25,
    },
    infojobs: {
        keyword:            'empleo',
        province:           'Madrid',
        maxItems:           25,
        proxyConfiguration: { useApifyProxy: true },
    },
    wallapop: {
        query:              'buscar',
        maxItems:           25,
        latitude:           40.41,
        longitude:          -3.70,
        distance:           '50',
        fetchDetails:       false,
        proxyConfiguration: { useApifyProxy: true },
    },
    vinted: {
        searchQuery: 'ropa',
        domain:      'vinted.es',
        maxItems:    25,
    },
};

// ── Shared run + poll + fetch ─────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const runApifyScraper = async (marketplaceId, customInput = {}) => {
    const TOKEN = process.env.APIFY_API_TOKEN;
    if (!TOKEN) throw new Error('APIFY_API_TOKEN not configured');

    const actorId = ACTOR_IDS[marketplaceId];
    if (!actorId) throw new Error(`No Apify actor configured for: ${marketplaceId}`);

    const input = { ...DEFAULT_INPUTS[marketplaceId], ...customInput };

    // 1 ▸ Start run
    const startRes = await fetch(
        `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/runs?token=${TOKEN}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
    );

    if (!startRes.ok) {
        const body = await startRes.text();
        throw new Error(`Actor start failed (${startRes.status}): ${body.substring(0, 200)}`);
    }

    const { data: run } = await startRes.json();
    const { id: runId, defaultDatasetId: datasetId } = run;
    console.log(`[Apify] ▶ ${marketplaceId} | run=${runId} | actor=${actorId}`);

    // 2 ▸ Poll until SUCCEEDED or terminal failure
    const deadline = Date.now() + MAX_MS;
    let lastStatus = run.status;

    while (Date.now() < deadline) {
        await sleep(POLL_MS);

        const statusRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${TOKEN}`).catch(() => null);
        if (!statusRes?.ok) continue;

        const { data: runStatus } = await statusRes.json();
        lastStatus = runStatus.status;
        console.log(`[Apify] ${marketplaceId} status → ${lastStatus}`);

        if (lastStatus === 'SUCCEEDED') break;
        if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(lastStatus)) {
            throw new Error(`Actor run ${lastStatus} for ${marketplaceId}`);
        }
    }

    if (lastStatus !== 'SUCCEEDED') {
        throw new Error(`Actor timed out after ${MAX_MS / 60000}min for ${marketplaceId}`);
    }

    // 3 ▸ Fetch dataset
    const dataRes = await fetch(
        `${APIFY_BASE}/datasets/${datasetId}/items?token=${TOKEN}&clean=true&limit=${ITEMS_CAP}`
    );
    if (!dataRes.ok) throw new Error(`Dataset fetch failed (${dataRes.status})`);

    const items = await dataRes.json();
    console.log(`[Apify] ${marketplaceId} → ${items.length} items`);
    return normalise(marketplaceId, items);
};

// ── Per-platform normalisers ──────────────────────────────────────────────

const normalise = (id, items) => {
    const fn = NORMALISERS[id] || normaliseGeneric;
    return items.map(fn);
};

const uid = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

const pickPhone = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (Array.isArray(v))      return v[0]?.toString().trim() || null;
    if (typeof v === 'object') return v.number || v.value || v.phone || null;
    return String(v).trim() || null;
};

const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '') ?? null;

// ── Real estate ──────────────────────────────────────────────────────────

const normaliseIdealista = (item) => ({
    id:           pick(item.propertyCode, item.id) || uid('id'),
    source:       'idealista',
    category:     'real_estate',
    title:        pick(item.suggestedTexts?.subtitle, item.title, item.description?.slice(0, 80)) || 'Property',
    price:        item.price ?? null,
    currency:     'EUR',
    location:     [item.district, item.municipality, item.province].filter(Boolean).join(', ') || item.address || null,
    url:          item.url ? `https://www.idealista.com${item.url}` : null,
    image:        item.thumbnail || item.multimedia?.images?.[0]?.url || null,
    description:  item.description || null,
    fetchedAt:    new Date().toISOString(),
    size:         item.size ?? null,
    rooms:        item.rooms ?? null,
    floor:        item.floor?.toString() ?? null,
    seller_name:  pick(item.agencyName, item.contactInfo?.agencyName, item.suggestedTexts?.title),
    seller_phone: pickPhone(item.contactInfo?.phone1 || item.phone || item.contactInfo?.phones),
    seller_email: pick(item.contactInfo?.email, item.email),
    contact_url:  item.contactInfo?.url || null,
    rawData:      item,
});

const normaliseFotocasa = (item) => ({
    id:           pick(item.id, item.propertyId) || uid('fc'),
    source:       'fotocasa',
    category:     'real_estate',
    title:        pick(item.title, item.name, item.subtitle) || 'Property',
    price:        item.price?.value ?? item.price ?? null,
    currency:     'EUR',
    location:     pick(item.address, item.location, item.municipality) || null,
    url:          item.url || item.link || null,
    image:        item.multimedia?.[0]?.url || item.image || item.thumbnail || null,
    description:  item.description || item.features?.join(', ') || null,
    fetchedAt:    new Date().toISOString(),
    size:         item.surface ?? item.size ?? null,
    rooms:        item.rooms ?? item.bedrooms ?? null,
    floor:        item.floor?.toString() ?? null,
    seller_name:  pick(item.agency?.name, item.advertiser?.name, item.contactName),
    seller_phone: pickPhone(item.agency?.phone || item.advertiser?.phone || item.phone),
    seller_email: pick(item.agency?.email, item.advertiser?.email, item.email),
    contact_url:  item.agency?.url || item.advertiser?.url || null,
    rawData:      item,
});

const normalisePisos = (item) => ({
    id:           pick(item.id, item.reference, item.ref) || uid('ps'),
    source:       'pisos',
    category:     'real_estate',
    title:        pick(item.title, item.name) || 'Property',
    price:        item.price ?? null,
    currency:     'EUR',
    location:     pick(item.location, item.district, item.city) || null,
    url:          item.url || item.link || null,
    image:        item.image || item.thumbnail || item.photos?.[0] || null,
    description:  item.description || null,
    fetchedAt:    new Date().toISOString(),
    size:         item.surface ?? item.size ?? null,
    rooms:        item.rooms ?? item.bedrooms ?? null,
    floor:        item.floor?.toString() ?? null,
    seller_name:  pick(item.agency, item.agencyName, item.advertiserName),
    seller_phone: pickPhone(item.phone || item.advertiserPhone || item.agencyPhone),
    seller_email: pick(item.email, item.advertiserEmail),
    contact_url:  item.advertiserUrl || null,
    rawData:      item,
});

// ── Vehicles ──────────────────────────────────────────────────────────────

const normaliseCochesNet = (item) => ({
    id:           pick(item.id, item.vehicleId, item.adId) || uid('cn'),
    source:       'coches_net',
    category:     'vehicles',
    title:        [item.make || item.brand, item.model, item.version].filter(Boolean).join(' ') || pick(item.title, item.name) || 'Vehicle',
    price:        item.price?.value ?? item.price ?? null,
    currency:     'EUR',
    location:     pick(item.location?.city, item.location?.province, item.province, item.city) || null,
    url:          item.url || item.link || null,
    image:        item.images?.[0] || item.image || item.thumbnail || null,
    description:  item.description || null,
    fetchedAt:    new Date().toISOString(),
    brand:        pick(item.make, item.brand),
    model:        item.model || null,
    year:         item.year ? parseInt(item.year) : null,
    mileage:      item.km ?? item.mileage ?? null,
    fuel:         item.fuel || item.fuelType || null,
    seller_name:  pick(item.dealer?.name, item.seller?.name, item.advertiserName, item.dealerName),
    seller_phone: pickPhone(item.dealer?.phone || item.seller?.phone || item.phone),
    seller_email: pick(item.dealer?.email, item.seller?.email, item.email),
    contact_url:  item.dealer?.url || item.seller?.url || null,
    rawData:      item,
});

const normaliseAutoscout = (item) => ({
    id:           pick(item.id, item.vehicleId, item.guid) || uid('as'),
    source:       'autoscout',
    category:     'vehicles',
    title:        [item.make, item.model, item.version].filter(Boolean).join(' ') || pick(item.title) || 'Vehicle',
    price:        item.price?.value ?? item.price ?? null,
    currency:     item.price?.currency || 'EUR',
    location:     [item.location?.city, item.location?.country].filter(Boolean).join(', ') || null,
    url:          item.url || null,
    image:        item.images?.[0] || item.image || null,
    description:  item.description || null,
    fetchedAt:    new Date().toISOString(),
    brand:        pick(item.make, item.brand),
    model:        item.model || null,
    year:         item.firstRegistration ? parseInt(item.firstRegistration) : (item.year ?? null),
    mileage:      item.mileage?.value ?? item.mileage ?? null,
    fuel:         item.fuel || item.fuelType || null,
    seller_name:  pick(item.seller?.name, item.dealer?.name, item.sellerName),
    seller_phone: pickPhone(item.seller?.phone || item.dealer?.phone || item.phone),
    seller_email: pick(item.seller?.email, item.dealer?.email, item.email),
    contact_url:  item.seller?.url || item.dealer?.url || null,
    rawData:      item,
});

// ── Jobs ──────────────────────────────────────────────────────────────────

const normaliseInfojobs = (item) => ({
    id:           pick(item.id, item.jobId, item.offerId) || uid('ij'),
    source:       'infojobs',
    category:     'jobs',
    title:        pick(item.title, item.position, item.jobTitle) || 'Job Offer',
    price:        null,     // use salary field instead
    currency:     'EUR',
    location:     pick(item.location, item.city, item.province) || null,
    url:          item.url || item.link || null,
    image:        item.company?.logo || item.logo || null,
    description:  item.description || item.requirements || null,
    fetchedAt:    new Date().toISOString(),
    company:      pick(item.company?.name, item.companyName, item.employer),
    salary:       pick(item.salary, item.salaryDescription, item.salaryRange),
    contract:     pick(item.contractType, item.contract, item.jobType),
    remote:       item.remote ?? item.telecommuting ?? false,
    seller_name:  pick(item.company?.name, item.companyName, item.recruiterName),
    seller_phone: pickPhone(item.company?.phone || item.recruiterPhone || item.phone),
    seller_email: pick(item.company?.email, item.recruiterEmail, item.email),
    contact_url:  item.company?.url || item.recruiterUrl || null,
    rawData:      item,
});

// ── P2P (no direct phone/email — platform messaging only) ────────────────

const normaliseWallapop = (item) => ({
    id:           pick(item.id, item.itemId) || uid('wp'),
    source:       'wallapop',
    category:     'general',
    title:        pick(item.title, item.name) || 'Item',
    price:        item.price ?? item.salePrice ?? null,
    currency:     item.currency || 'EUR',
    location:     pick(item.location?.city, item.location?.postalCode, item.city) || null,
    url:          item.url || item.webLink || null,
    image:        item.images?.[0]?.medium || item.image || item.thumbnail || null,
    description:  item.description || null,
    fetchedAt:    new Date().toISOString(),
    seller_name:  pick(item.seller?.username, item.user?.name, item.sellerName),
    seller_phone: null,   // Wallapop hides contact info behind in-app messaging
    seller_email: null,
    contact_url:  item.seller?.url || item.user?.profileUrl || null,
    rawData:      item,
});

const normaliseVinted = (item) => ({
    id:           pick(item.id, item.itemId) || uid('vt'),
    source:       'vinted',
    category:     'clothes',
    title:        pick(item.title, item.name) || 'Item',
    price:        item.price ?? null,
    currency:     item.currency || 'EUR',
    location:     pick(item.city, item.country) || null,
    url:          item.url || null,
    image:        item.photos?.[0]?.url || item.image || item.thumbnail || null,
    description:  item.description || item.brand || null,
    fetchedAt:    new Date().toISOString(),
    seller_name:  pick(item.seller?.login, item.user?.login, item.sellerName),
    seller_phone: null,   // Vinted hides contact info behind in-app messaging
    seller_email: null,
    contact_url:  item.seller?.profileUrl || item.user?.profileUrl || null,
    rawData:      item,
});

const normaliseGeneric = (item) => ({
    id:           pick(item.id) || uid('gn'),
    source:       item.source || 'unknown',
    category:     item.category || 'general',
    title:        pick(item.title, item.name) || 'Listing',
    price:        item.price ?? null,
    currency:     item.currency || 'EUR',
    location:     item.location || null,
    url:          item.url || null,
    image:        item.image || item.thumbnail || null,
    description:  item.description || null,
    fetchedAt:    new Date().toISOString(),
    seller_name:  null, seller_phone: null, seller_email: null, contact_url: null,
    rawData:      item,
});

const NORMALISERS = {
    idealista:  normaliseIdealista,
    fotocasa:   normaliseFotocasa,
    pisos:      normalisePisos,
    coches_net: normaliseCochesNet,
    autoscout:  normaliseAutoscout,
    infojobs:   normaliseInfojobs,
    wallapop:   normaliseWallapop,
    vinted:     normaliseVinted,
};
