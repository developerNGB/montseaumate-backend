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

export const countActiveEmployeesFromRows = (rfRow, lfRow) => {
    let n = 0;
    if (rfRow?.is_active === true) n++;
    if (rfRow?.lead_capture_active === true) n++;
    if (lfRow?.is_active === true) n++;
    return n;
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
        patch.is_active !== undefined ? patch.is_active : !!rf.is_active;
    const capActive =
        patch.lead_capture_active !== undefined
            ? patch.lead_capture_active
            : !!rf.lead_capture_active;
    const followActive =
        patch.followup_active !== undefined
            ? patch.followup_active
            : !!lf.is_active;

    let n = 0;
    if (isActive) n++;
    if (capActive) n++;
    if (followActive) n++;
    return n;
};
