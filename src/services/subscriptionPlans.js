/**
 * Billing / subscription helpers: plan tiers, marketplace run credits, automation slots.
 * Env overrides (optional integers, >= 0):
 *   MARKETPLACE_RUNS_BASIC, MARKETPLACE_RUNS_GROWTH,
 *   MARKETPLACE_RUNS_PRO, MARKETPLACE_RUNS_ENTERPRISE
 * Employee caps (unless ENV set): MARKETPLACE_MAX_EMPLOYEES_BASIC, _GROWTH, _PRO, _ENTERPRISE
 */

const parseIntEnv = (key, fallback) => {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(0, n);
};

export const isTrialing = (trialEndsAt) => {
    if (!trialEndsAt) return false;
    const t = trialEndsAt instanceof Date ? trialEndsAt : new Date(trialEndsAt);
    return !Number.isNaN(t.valueOf()) && t > new Date();
};

/** Maps DB plan ids (free, Growth, Pro, …) to internal tier keys */
export const normalizeBillingPlan = (plan = 'free') => {
    const p = String(plan || 'free').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (p.includes('trial')) return 'free_trial';
    if (p.includes('enterprise')) return 'enterprise';
    if (p.includes('growth')) return 'growth';
    if (p === 'pro' || p.endsWith('_pro')) return 'pro';
    if (['free', 'basic', 'starter'].includes(p) || p.includes('starter')) return 'basic';
    return 'basic';
};

const FALLBACK_RUNS = {
    basic: 15,
    growth: 45,
    pro: 100,
    enterprise: 500,
};

const FALLBACK_MAX_EMPLOYEES = {
    basic: 1,
    growth: 2,
    pro: 3,
    enterprise: 99,
};

/**
 * Allowed marketplace "Get leads" runs per UTC month while not trialing.
 * During trial: always 0 (paid feature).
 */
export const getMarketplaceRunsLimit = (plan, trialEndsAt) => {
    if (isTrialing(trialEndsAt)) return 0;
    const tier = normalizeBillingPlan(plan);
    if (tier === 'free_trial') return 0;
    switch (tier) {
        case 'growth':
            return parseIntEnv('MARKETPLACE_RUNS_GROWTH', FALLBACK_RUNS.growth);
        case 'pro':
            return parseIntEnv('MARKETPLACE_RUNS_PRO', FALLBACK_RUNS.pro);
        case 'enterprise':
            return parseIntEnv('MARKETPLACE_RUNS_ENTERPRISE', FALLBACK_RUNS.enterprise);
        case 'basic':
        default:
            return parseIntEnv('MARKETPLACE_RUNS_BASIC', FALLBACK_RUNS.basic);
    }
};

export const getMaxEmployees = (plan, trialEndsAt) => {
    const tier = normalizeBillingPlan(plan);
    if (tier === 'free_trial' || isTrialing(trialEndsAt)) return 1;
    switch (tier) {
        case 'growth':
            return parseIntEnv('MARKETPLACE_MAX_EMPLOYEES_GROWTH', FALLBACK_MAX_EMPLOYEES.growth);
        case 'pro':
            return parseIntEnv('MARKETPLACE_MAX_EMPLOYEES_PRO', FALLBACK_MAX_EMPLOYEES.pro);
        case 'enterprise':
            return parseIntEnv('MARKETPLACE_MAX_EMPLOYEES_ENTERPRISE', FALLBACK_MAX_EMPLOYEES.enterprise);
        case 'basic':
        default:
            return parseIntEnv('MARKETPLACE_MAX_EMPLOYEES_BASIC', FALLBACK_MAX_EMPLOYEES.basic);
    }
};

/**
 * Billing slot count: Review funnel + Lead capture share one automation row —
 * anytime either flag is ON, it consumes one employee slot (not two).
 */
export const countActiveEmployeesFromRows = (rfRow, lfRow) => {
    let n = 0;
    if (rfRow?.is_active === true || rfRow?.lead_capture_active === true) n += 1;
    if (lfRow?.is_active === true) n += 1;
    return n;
};

/**
 * Highest follow-up automation steps allowed per tier (beyond the legacy single-message path).
 * `null` means no cap.
 */
export const getMaxFollowupSequenceSteps = (plan, trialEndsAt) => {
    if (isTrialing(trialEndsAt)) return 2;
    const tier = normalizeBillingPlan(plan);
    if (tier === 'free_trial') return 2;
    switch (tier) {
        case 'growth':
            return 5;
        case 'pro':
        case 'enterprise':
            return null;
        case 'basic':
        default:
            return 2;
    }
};

/**
 * Plan-based feature gates (single source of truth for APIs + `/api/apollo/usage`).
 * Tier names are internal; `tier_key` aligns with normalized billing tier.
 */
export const getPlanEntitlements = (plan, trialEndsAt) => {
    const trialing = isTrialing(trialEndsAt);
    const normalized = normalizeBillingPlan(plan);

    /** Paid product tier ignoring capitalisation; trial users treated as Starter for premium flags */
    let productTier = 'starter';
    if (!trialing && normalized !== 'free_trial') {
        if (normalized === 'enterprise') productTier = 'enterprise';
        else if (normalized === 'pro') productTier = 'pro';
        else if (normalized === 'growth') productTier = 'growth';
        else productTier = 'starter';
    }

    const classifiedMarketplaceBulk =
        !trialing && (productTier === 'growth' || productTier === 'pro' || productTier === 'enterprise');
    const apolloContactSearch =
        !trialing && (productTier === 'growth' || productTier === 'pro' || productTier === 'enterprise');
    const apolloDeepEnrich =
        !trialing && (productTier === 'pro' || productTier === 'enterprise');

    const runsLimit = getMarketplaceRunsLimit(plan, trialEndsAt);
    const maxEmp = getMaxEmployees(plan, trialEndsAt);

    return {
        plan: String(plan ?? 'free').trim(),
        normalized_tier: normalized,
        trial_active: trialing,
        product_tier: productTier,
        max_followup_sequence_steps: getMaxFollowupSequenceSteps(plan, trialEndsAt),
        /** POST /api/marketplace/fetch + /store — multi-portal Apify classified scrape */
        classified_marketplace_bulk: classifiedMarketplaceBulk,
        /** POST /api/apollo/search — Apollo.io people search */
        apollo_b2b_search: apolloContactSearch,
        /** POST /api/apollo/enrich — paid enrichment */
        apollo_enrich: apolloDeepEnrich,
        runs_limit: runsLimit,
        max_employees: maxEmp,
        marketplace_scout_included: runsLimit > 0,
    };
};

/**
 * Simulate count after toggle or config save fields.
 */
export const countEmployeesAfterPatch = ({
    rf = {},
    lf = {},
    patch = {},
}) => {
    const isActive =
        patch.is_active !== undefined ? !!patch.is_active : !!rf.is_active;
    const capActive =
        patch.lead_capture_active !== undefined
            ? !!patch.lead_capture_active
            : !!rf.lead_capture_active;
    const followActive =
        patch.followup_active !== undefined
            ? !!patch.followup_active
            : !!lf.is_active;

    let n = 0;
    if (isActive || capActive) n += 1;
    if (followActive) n += 1;
    return n;
};
