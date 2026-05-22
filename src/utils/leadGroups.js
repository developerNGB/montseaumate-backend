export const DEFAULT_LEAD_GROUP = 'General';

export function normalizeLeadGroup(input, fallback = DEFAULT_LEAD_GROUP) {
    const v = String(input ?? '').trim();
    if (!v) return fallback;
    return v.slice(0, 100);
}
