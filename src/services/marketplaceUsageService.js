import {
    getMarketplaceRunsLimit,
    getMaxEmployees,
    countActiveEmployeesFromRows,
    normalizeBillingPlan,
    isTrialing,
} from './subscriptionPlans.js';

/** @deprecated Prefer getMarketplaceRunsLimit + search_runs; kept for dashboards */
export const normalizePlan = (plan = 'free') => normalizeBillingPlan(plan);

export const getCurrentUsagePeriod = () => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Legacy name: was “monthly leads cap”; now maps to marketplace run limit for backwards compat callers */
export const getMarketplaceLimit = (plan) =>
    getMarketplaceRunsLimit(plan, null);

/**
 * Lightweight usage for UI polling (pool or client).
 */
export const getUsageSnapshot = async (client, userId) => {
    const period = getCurrentUsagePeriod();

    const userRes = await client.query(
        'SELECT plan, trial_ends_at FROM users WHERE id = $1',
        [userId]
    );
    const plan = userRes.rows[0]?.plan ?? 'free';
    const trialEndsAt = userRes.rows[0]?.trial_ends_at ?? null;

    const runsLimit = getMarketplaceRunsLimit(plan, trialEndsAt);

    let usageRow = (
        await client.query(
            `SELECT leads_fetched, search_runs
             FROM marketplace_usage
             WHERE user_id = $1 AND period = $2`,
            [userId, period]
        )
    ).rows[0];

    let rfRow = (
        await client.query(
            'SELECT is_active, lead_capture_active FROM review_funnel_settings WHERE user_id = $1',
            [userId]
        )
    ).rows[0];
    let lfRow = (
        await client.query(
            'SELECT is_active FROM lead_followup_settings WHERE user_id = $1',
            [userId]
        )
    ).rows[0];

    const activeEmployees = countActiveEmployeesFromRows(rfRow || {}, lfRow || {});
    const maxEmployees = getMaxEmployees(plan, trialEndsAt);

    const leadsFetched = Number(usageRow?.leads_fetched || 0);
    const runsUsed = Number(usageRow?.search_runs || 0);

    const runsRemaining = runsLimit <= 0 ? 0 : Math.max(runsLimit - runsUsed, 0);

    return {
        plan,
        period,
        normalizedPlan: normalizeBillingPlan(plan),
        trial_active: isTrialing(trialEndsAt),
        runs_limit: runsLimit,
        runs_used: runsUsed,
        runs_remaining: runsRemaining,
        leads_fetched_month: leadsFetched,
        marketplace_included: runsLimit > 0,
        /** legacy fields */
        limit: runsLimit,
        used: runsUsed,
        remaining: runsRemaining,
        employee_slots_max: maxEmployees,
        employee_slots_active: activeEmployees,
        employee_slots_remaining: Math.max(maxEmployees - activeEmployees, 0),
    };
};

/** Called after scrape completes — tracks total contacts pulled this month */
export const incrementMarketplaceUsage = async (client, userId, fetchedCount) => {
    if (!fetchedCount || fetchedCount <= 0) return null;

    const period = getCurrentUsagePeriod();
    await client.query(
        `INSERT INTO marketplace_usage (user_id, period, leads_fetched, search_runs, updated_at)
         VALUES ($1, $2, $3, 0, NOW())
         ON CONFLICT (user_id, period)
         DO UPDATE SET leads_fetched = marketplace_usage.leads_fetched + EXCLUDED.leads_fetched,
                       updated_at = NOW()
         RETURNING leads_fetched`,
        [userId, period, fetchedCount]
    );
};

/**
 * Reserve one Marketplace search run inside an open transaction.
 * Locks the user row, then marketplace_usage row for the UTC month.
 * @returns {{ ok: boolean, code?: string, snapshot?: object }}
 */
export const tryConsumeMarketplaceRun = async (client, userId) => {
    const period = getCurrentUsagePeriod();

    const lockedUser = await client.query(
        'SELECT plan, trial_ends_at FROM users WHERE id = $1 FOR UPDATE',
        [userId]
    );
    const rowU = lockedUser.rows[0];
    if (!rowU) return { ok: false, code: 'USER_NOT_FOUND' };

    const runsLimit = getMarketplaceRunsLimit(rowU.plan, rowU.trial_ends_at);
    if (runsLimit <= 0) {
        return {
            ok: false,
            code: 'MARKETPLACE_NOT_INCLUDED',
            snapshot: await buildMiniSnapshot(client, userId, period, rowU, 0),
        };
    }

    await client.query(
        `INSERT INTO marketplace_usage (user_id, period, leads_fetched, search_runs, updated_at)
         VALUES ($1, $2, 0, 0, NOW())
         ON CONFLICT (user_id, period) DO NOTHING`,
        [userId, period]
    );

    const lockedUsage = await client.query(
        `SELECT search_runs, leads_fetched
         FROM marketplace_usage
         WHERE user_id = $1 AND period = $2
         FOR UPDATE`,
        [userId, period]
    );
    const used = Number(lockedUsage.rows[0]?.search_runs || 0);
    if (used >= runsLimit) {
        return {
            ok: false,
            code: 'MARKETPLACE_LIMIT_REACHED',
            snapshot: await buildMiniSnapshot(client, userId, period, rowU, used),
        };
    }

    await client.query(
        `UPDATE marketplace_usage
         SET search_runs = search_runs + 1, updated_at = NOW()
         WHERE user_id = $1 AND period = $2`,
        [userId, period]
    );

    const newUsed = used + 1;
    return {
        ok: true,
        snapshot: await buildMiniSnapshot(client, userId, period, rowU, newUsed, runsLimit),
    };
};

async function buildMiniSnapshot(client, userId, period, userRow, searchRunsUsed, runsLimitExplicit) {
    const plan = userRow.plan ?? 'free';
    const trialEndsAt = userRow.trial_ends_at ?? null;
    const runsLimit =
        typeof runsLimitExplicit === 'number'
            ? runsLimitExplicit
            : getMarketplaceRunsLimit(plan, trialEndsAt);
    const lf = await client.query('SELECT is_active FROM lead_followup_settings WHERE user_id = $1', [
        userId,
    ]);
    const rf = await client.query(
        'SELECT is_active, lead_capture_active FROM review_funnel_settings WHERE user_id = $1',
        [userId]
    );

    const maxEmployees = getMaxEmployees(plan, trialEndsAt);
    const activeEmployees = countActiveEmployeesFromRows(rf.rows[0] || {}, lf.rows[0] || {});

    const runsRemaining = runsLimit <= 0 ? 0 : Math.max(runsLimit - searchRunsUsed, 0);
    let leadsMonth = 0;
    try {
        const lr = await client.query(
            'SELECT leads_fetched FROM marketplace_usage WHERE user_id = $1 AND period = $2',
            [userId, period]
        );
        leadsMonth = Number(lr.rows[0]?.leads_fetched || 0);
    } catch (_) {
        /* non-fatal */
    }

    return {
        plan,
        period,
        normalizedPlan: normalizeBillingPlan(plan),
        trial_active: isTrialing(trialEndsAt),
        runs_limit: runsLimit,
        runs_used: searchRunsUsed,
        runs_remaining: runsRemaining,
        leads_fetched_month: leadsMonth,
        marketplace_included: runsLimit > 0,
        employee_slots_max: maxEmployees,
        employee_slots_active: activeEmployees,
        employee_slots_remaining: Math.max(maxEmployees - activeEmployees, 0),
    };
}
