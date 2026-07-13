/**
 * Server-side lead scoring — mirrors src/utils/leadContactActions.js (frontend heuristic)
 * plus "hot intent" keyword detection so newly captured leads can trigger an instant alert.
 */

const HOT_KEYWORDS = [
    'urgent', 'urgente', 'asap', 'as soon as possible', 'immediately', 'inmediato', 'inmediatamente',
    'right away', 'today', 'hoy', 'now', 'ahora', 'call me', 'llamame', 'llámame', 'call back',
    'ready to buy', 'ready to start', 'listo para comprar', 'budget', 'presupuesto',
    'quote', 'cotizacion', 'cotización', 'price', 'pricing', 'precio', 'cost', 'costo',
    'how much', 'cuanto cuesta', 'cuánto cuesta', 'sign up', 'get started', 'empezar',
    'need this', 'necesito', 'as soon as', 'this week', 'esta semana',
];

/**
 * @param {object} lead - { email, phone, consent_given, marketing_consent, lead_status, message, filtering_responses }
 * @returns {{ score: number, tier: 'low'|'mid'|'high', matchedKeywords: string[] }}
 */
export function computeLeadScore(lead = {}) {
    const { email, phone, consent_given, marketing_consent, lead_status, message, filtering_responses } = lead;
    let score = 35;
    if (email && String(email).trim()) score += 15;
    if (phone && String(phone).trim()) score += 15;
    if (consent_given || marketing_consent) score += 10;
    if (lead_status === 'Contacted') score += 15;
    if (lead_status === 'Closed') score += 20;

    let textParts = [];
    if (message) textParts.push(String(message));
    if (filtering_responses && typeof filtering_responses === 'object') {
        textParts = textParts.concat(Object.values(filtering_responses).map((v) => String(v ?? '')));
    }
    const text = textParts.join(' ').toLowerCase();
    const matchedKeywords = HOT_KEYWORDS.filter((k) => text.includes(k));
    if (matchedKeywords.length > 0) {
        score += Math.min(15, matchedKeywords.length * 5);
    }

    const HIGH_PRIORITY_PHRASES = [
        'ready to buy this month', 'comprar este mes', 'comprar hoy', 'ready to buy', 'listo para comprar',
        'ready to start', 'this month', 'este mes', 'urgente', 'urgent', 'immediately', 'inmediatamente'
    ];
    const hasHighPriorityPhrase = HIGH_PRIORITY_PHRASES.some(phrase => text.includes(phrase));
    if (hasHighPriorityPhrase) {
        score = Math.max(80, score);
    }

    score = Math.max(0, Math.min(100, score));
    return { score, tier: getLeadScoreTier(score), matchedKeywords };
}

export function getLeadScoreTier(score) {
    if (score >= 80) return 'high';
    if (score >= 60) return 'mid';
    return 'low';
}
