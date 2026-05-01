const MONTHLY_LIMITS = {
    free: 0,
    free_trial: 0,
    trial: 0,
    starter: 100,
    growth: 500,
    pro: 500,
    enterprise: 2000,
};

export const normalizePlan = (plan = 'free') => {
    const normalized = String(plan || 'free').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (normalized.includes('trial')) return 'free_trial';
    if (normalized.includes('starter')) return 'starter';
    if (normalized.includes('growth')) return 'growth';
    if (normalized.includes('enterprise')) return 'enterprise';
    if (normalized.includes('pro')) return 'pro';
    return normalized || 'free';
};

export const getMarketplaceLimit = (plan) => MONTHLY_LIMITS[normalizePlan(plan)] ?? 0;

export const getCurrentUsagePeriod = () => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const getUsageSnapshot = async (client, userId) => {
    const period = getCurrentUsagePeriod();
    const userRes = await client.query('SELECT plan FROM users WHERE id = $1', [userId]);
    const plan = userRes.rows[0]?.plan || 'free';
    const limit = getMarketplaceLimit(plan);

    const usageRes = await client.query(
        `SELECT leads_fetched
         FROM marketplace_usage
         WHERE user_id = $1 AND period = $2`,
        [userId, period]
    );

    const used = Number(usageRes.rows[0]?.leads_fetched || 0);
    return {
        plan,
        period,
        limit,
        used,
        remaining: Math.max(limit - used, 0),
    };
};

export const incrementMarketplaceUsage = async (client, userId, fetchedCount) => {
    if (!fetchedCount || fetchedCount <= 0) return null;

    const period = getCurrentUsagePeriod();
    const usageRes = await client.query(
        `INSERT INTO marketplace_usage (user_id, period, leads_fetched, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, period)
         DO UPDATE SET leads_fetched = marketplace_usage.leads_fetched + EXCLUDED.leads_fetched,
                       updated_at = NOW()
         RETURNING leads_fetched`,
        [userId, period, fetchedCount]
    );

    return usageRes.rows[0];
};
