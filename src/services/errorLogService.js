import pool from '../db/pool.js';

/**
 * Persist an error event for admin review.
 * @param {Object} params
 * @param {'error'|'warn'|'info'} [params.level]
 * @param {string} [params.code]
 * @param {string} [params.message]
 * @param {string} [params.stack]
 * @param {Object} [params.context]
 * @param {string} [params.userId]
 * @param {string} [params.route]
 * @param {string} [params.method]
 * @param {string} [params.ip]
 */
export async function insertErrorEvent({ level='error', code=null, message=null, stack=null, context=null, userId=null, route=null, method=null, ip=null }={}) {
    try {
        await pool.query(
            `INSERT INTO error_events (level, code, message, stack, context, user_id, route, method, ip, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
            [level, code, message, stack, JSON.stringify(context||{}), userId, route, method, ip]
        );
    } catch (e) {
        // As a last resort, log to console only; avoid throwing from logger
        console.error('[ErrorLogService] insert failed:', e.message);
    }
}

export async function listErrorEvents({ q=null, level=null, limit=200, offset=0 }={}) {
    const params = [];
    const where = [];
    if (q) { params.push(`%${q.toLowerCase()}%`); where.push(`(lower(message) LIKE $${params.length} OR lower(code) LIKE $${params.length} OR lower(stack) LIKE $${params.length})`); }
    if (level) { params.push(level); where.push(`level = $${params.length}`); }
    const sql = `SELECT id, level, code, message, stack, context, user_id, route, method, ip, created_at, resolved
                 FROM error_events
                 ${where.length? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC
                 LIMIT ${Number(limit)||200} OFFSET ${Number(offset)||0}`;
    const r = await pool.query(sql, params);
    return r.rows;
}

export async function markErrorResolved(id, resolved=true) {
    await pool.query(`UPDATE error_events SET resolved = $2, resolved_at = CASE WHEN $2 THEN NOW() ELSE NULL END WHERE id = $1`, [id, resolved]);
}

/** Mark many rows resolved (e.g. clear CSRF noise after a middleware fix). */
export async function bulkResolveErrors({ code = null, onlyOpen = true } = {}) {
    const params = [];
    const where = [];
    if (onlyOpen) where.push('resolved IS NOT TRUE');
    if (code) {
        params.push(code);
        where.push(`code = $${params.length}`);
    }
    const sql = `UPDATE error_events SET resolved = TRUE, resolved_at = NOW()
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 RETURNING id`;
    const r = await pool.query(sql, params);
    return r.rowCount ?? 0;
}
