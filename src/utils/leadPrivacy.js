/**
 * Synthetic / internal inbox values saved for persistence or dedupe.
 * Never treat as customer email (UI, exports, SMTP).
 */
export function isPlaceholderLeadEmail(email) {
    if (email == null || email === '') return false;
    const e = String(email).trim().toLowerCase();
    if (/@placeholder\.com$/i.test(e)) return true;
    if (e === 'pending@apify.local') return true;
    return false;
}

/** Safe value for APIs and dashboards (never leaks internal IDs). */
export function sanitizeLeadEmailForPublic(email) {
    if (email == null) return '';
    const e = String(email).trim();
    if (!e || isPlaceholderLeadEmail(e)) return '';
    return e;
}

export function sanitizeLeadRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    if ('email' in out) out.email = sanitizeLeadEmailForPublic(out.email);
    return out;
}

export function sanitizeLeads(rows) {
    if (!Array.isArray(rows)) return rows;
    return rows.map(sanitizeLeadRow);
}
