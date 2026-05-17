import pool from '../db/pool.js';
import { sanitizeLeadEmailForPublic } from '../utils/leadPrivacy.js';
import * as whatsappService from '../services/whatsappService.js';

/** Minimum wait before retrying a lead that failed to send (avoids cron spam). */
export const FOLLOWUP_RETRY_COOLDOWN_MIN = Math.max(
    15,
    Math.min(24 * 60, parseInt(process.env.FOLLOWUP_RETRY_COOLDOWN_MINUTES || '60', 10) || 60),
);

/** Admin inbox: at most one follow-up failure digest per user per window. */
export const FOLLOWUP_ALERT_COOLDOWN_MS =
    Math.max(15, parseInt(process.env.FOLLOWUP_ALERT_COOLDOWN_MINUTES || '360', 10) || 360) *
    60 *
    1000;

const followupAlertSentAt = new Map();

export function shouldSendFollowupFailureAlert(userId) {
    const key = String(userId);
    const last = followupAlertSentAt.get(key) || 0;
    if (Date.now() - last < FOLLOWUP_ALERT_COOLDOWN_MS) return false;
    followupAlertSentAt.set(key, Date.now());
    return true;
}

/**
 * @param {string[]} userIds
 * @returns {Promise<Map<string, { email: boolean, whatsapp: boolean }>>}
 */
export async function loadUserSendCapabilities(userIds) {
    const map = new Map();
    if (!userIds.length) return map;

    const unique = [...new Set(userIds.map(String))];
    const [smtpRes, intRes] = await Promise.all([
        pool.query(
            `SELECT user_id FROM smtp_settings WHERE user_id = ANY($1::uuid[]) AND is_active = true`,
            [unique],
        ),
        pool.query(
            `SELECT user_id, provider, access_token FROM integrations WHERE user_id = ANY($1::uuid[])`,
            [unique],
        ),
    ]);

    for (const id of unique) {
        map.set(id, { email: false, whatsapp: false });
    }
    for (const row of smtpRes.rows) {
        const cap = map.get(String(row.user_id));
        if (cap) cap.email = true;
    }
    for (const row of intRes.rows) {
        const cap = map.get(String(row.user_id));
        if (!cap) continue;
        if (row.provider === 'google' || row.provider === 'microsoft') {
            cap.email = true;
        }
        if (
            row.provider === 'whatsapp' &&
            row.access_token === 'whatsapp_native_session' &&
            whatsappService.getSessionStatus(row.user_id)?.status === 'connected'
        ) {
            cap.whatsapp = true;
        }
    }
    return map;
}

/**
 * @param {object} lead
 * @param {{ email: boolean, whatsapp: boolean }} caps
 */
export function assessLeadFollowup(lead, caps) {
    const sequence = lead._parsedSequence ?? [];
    if (sequence.length === 0) {
        return { kind: 'complete', reason: 'empty_sequence' };
    }

    const stepIndex = lead.followup_step_index || 0;
    if (stepIndex >= sequence.length) {
        return { kind: 'complete', reason: 'sequence_done' };
    }

    const phone = lead.phone?.trim();
    const email = sanitizeLeadEmailForPublic(lead.email);
    const wantsWa = lead.whatsapp_enabled !== false;
    const wantsEmail = lead.email_enabled !== false;

    const canWa = wantsWa && Boolean(phone) && caps.whatsapp;
    const canEmail = wantsEmail && Boolean(email) && caps.email;

    if (!canWa && !canEmail) {
        if (!wantsWa && !wantsEmail) {
            return { kind: 'complete', reason: 'channels_disabled' };
        }
        if (!phone && !email) {
            return { kind: 'skip', reason: 'no_contact_info' };
        }
        if (wantsWa && phone && !caps.whatsapp) {
            return { kind: 'skip', reason: 'whatsapp_not_connected' };
        }
        if (wantsEmail && email && !caps.email) {
            return { kind: 'skip', reason: 'email_not_configured' };
        }
        return { kind: 'skip', reason: 'cannot_send' };
    }

    return { kind: 'send', canWa, canEmail };
}
