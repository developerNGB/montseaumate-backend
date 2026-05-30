import pool from '../db/pool.js';

/**
 * Persist an error event for admin review.
 */
export async function insertErrorEvent({ level='error', code=null, message=null, stack=null, context=null, userId=null, route=null, method=null, ip=null }={}) {
    try {
        await pool.query(
            `INSERT INTO error_events (level, code, message, stack, context, user_id, route, method, ip, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
            [level, code, message, stack, JSON.stringify(context||{}), userId, route, method, ip]
        );
    } catch (e) {
        console.error('[ErrorLogService] insert failed:', e.message);
    }
}

function fingerprintExpr() {
    return `COALESCE(route, '') || '|' || COALESCE(lower(left(message, 200)), '')`;
}

/**
 * @param {Object} opts
 * @param {boolean} [opts.openOnly=true] — unresolved only
 * @param {boolean} [opts.includeStale=false] — include open errors older than maxAgeDays
 * @param {number} [opts.maxAgeDays=14]
 * @param {boolean} [opts.dedupe=true] — one row per route+message fingerprint (latest)
 */
export async function listErrorEvents({
    q=null,
    level=null,
    limit=200,
    offset=0,
    openOnly=true,
    includeStale=false,
    maxAgeDays=14,
    dedupe=true,
}={}) {
    const params = [];
    const where = [];

    if (openOnly) {
        where.push('resolved IS NOT TRUE');
    }
    if (!includeStale && !q) {
        params.push(Number(maxAgeDays) || 14);
        where.push(`created_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    }
    if (q) {
        params.push(`%${q.toLowerCase()}%`);
        where.push(`(lower(message) LIKE $${params.length} OR lower(code) LIKE $${params.length} OR lower(stack) LIKE $${params.length})`);
    }
    if (level && level !== 'all') {
        params.push(level);
        where.push(`level = $${params.length}`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const fp = fingerprintExpr();
    const lim = Math.min(Number(limit) || 200, 500);
    const off = Number(offset) || 0;

    if (dedupe) {
        const sql = `
            WITH base AS (
                SELECT id, level, code, message, stack, context, user_id, route, method, ip, created_at, resolved,
                       ${fp} AS fingerprint,
                       COUNT(*) OVER (PARTITION BY ${fp})::int AS occurrence_count,
                       ROW_NUMBER() OVER (PARTITION BY ${fp} ORDER BY created_at DESC) AS rn
                FROM error_events
                ${whereClause}
            )
            SELECT id, level, code, message, stack, context, user_id, route, method, ip, created_at, resolved, occurrence_count
            FROM base
            WHERE rn = 1
            ORDER BY created_at DESC
            LIMIT ${lim} OFFSET ${off}`;
        const r = await pool.query(sql, params);
        return r.rows;
    }

    const sql = `SELECT id, level, code, message, stack, context, user_id, route, method, ip, created_at, resolved
                 FROM error_events
                 ${whereClause}
                 ORDER BY created_at DESC
                 LIMIT ${lim} OFFSET ${off}`;
    const r = await pool.query(sql, params);
    return r.rows.map((row) => ({ ...row, occurrence_count: 1 }));
}

export async function countOpenErrorEvents({ maxAgeDays = 14, includeStale = false } = {}) {
    const params = [];
    const where = ['resolved IS NOT TRUE'];
    if (!includeStale) {
        params.push(Number(maxAgeDays) || 14);
        where.push(`created_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    }
    const fp = fingerprintExpr();
    const sql = `
        SELECT COUNT(DISTINCT ${fp})::int AS open_count
        FROM error_events
        WHERE ${where.join(' AND ')}`;
    const r = await pool.query(sql, params);
    return r.rows[0]?.open_count ?? 0;
}

export async function markErrorResolved(id, resolved=true) {
    await pool.query(
        `UPDATE error_events SET resolved = $2, resolved_at = CASE WHEN $2 THEN NOW() ELSE NULL END WHERE id = $1`,
        [id, resolved]
    );
}

/** Mark many rows resolved (e.g. clear CSRF noise after a middleware fix). */
export async function bulkResolveErrors({ code = null, onlyOpen = true, maxAgeDays = null } = {}) {
    const params = [];
    const where = [];
    if (onlyOpen) where.push('resolved IS NOT TRUE');
    if (code) {
        params.push(code);
        where.push(`code = $${params.length}`);
    }
    if (maxAgeDays) {
        params.push(Number(maxAgeDays));
        where.push(`created_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    }
    const sql = `UPDATE error_events SET resolved = TRUE, resolved_at = NOW()
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 RETURNING id`;
    const r = await pool.query(sql, params);
    return r.rowCount ?? 0;
}
