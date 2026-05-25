/**
 * Smoke-test WhatsApp + Gmail dispatch via production API.
 * Usage: node server/scripts/messaging-smoke-test.mjs [--send]
 * Without --send: read-only checks (integrations, WA status, lead readiness).
 * With --send: POST /api/leads/:id/trigger on one safe test lead (owner phone only).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { sendDynamicEmail } from '../src/services/emailService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const API = (process.env.BACKEND_URL || 'https://api.equipoexperto.com').replace(/\/$/, '');
const SEND = process.argv.includes('--send');

function signToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role || 'user', plan: user.plan || 'free' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );
}

async function api(method, path, token, body) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        data = { raw: await res.text().catch(() => '') };
    }
    return { status: res.status, ok: res.ok, data };
}

async function main() {
    if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
        console.error('Missing DATABASE_URL or JWT_SECRET in .env');
        process.exit(1);
    }

    const pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });

    try {
        const usersRes = await pool.query(`
            SELECT u.id, u.email, u.role, u.plan, u.status,
                   g.account_id AS google_account,
                   w.account_id AS wa_phone,
                   w.access_token AS wa_token
            FROM users u
            LEFT JOIN integrations g ON g.user_id = u.id AND g.provider = 'google'
            LEFT JOIN integrations w ON w.user_id = u.id AND w.provider = 'whatsapp'
            WHERE u.status = 'active'
            ORDER BY
                (CASE WHEN g.user_id IS NOT NULL AND w.access_token = 'whatsapp_native_session' THEN 0 ELSE 1 END),
                u.created_at DESC
            LIMIT 15
        `);

        const candidate = usersRes.rows.find(
            (r) => r.google_account && r.wa_token === 'whatsapp_native_session'
        );
        if (!candidate) {
            console.log('No active user with both Google + native WhatsApp integrations.');
            console.log('Sample users:', usersRes.rows.slice(0, 5).map((r) => ({
                email: r.email,
                google: !!r.google_account,
                wa: r.wa_token === 'whatsapp_native_session',
            })));
            process.exit(1);
        }

        const token = signToken(candidate);
        console.log('Testing as:', candidate.email);
        console.log('API:', API);
        console.log('---');

        const wa = await api('GET', '/api/whatsapp/status', token);
        console.log('WhatsApp status:', wa.status, wa.data?.status ?? wa.data);

        const integ = await api('GET', '/api/integrations', token);
        const providers = integ.data?.integrations?.map((i) => i.provider) || [];
        console.log('Integrations:', integ.status, providers.join(', ') || integ.data);

        const cfgRes = await pool.query(
            `SELECT automation_id, lead_capture_active, is_active
             FROM review_funnel_settings WHERE user_id = $1`,
            [candidate.id]
        );
        const automationId = cfgRes.rows[0]?.automation_id;

        const leadsRes = await pool.query(
            `SELECT id, full_name, phone, email, followup_step_index, followup_status
             FROM leads WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 10`,
            [candidate.id]
        );

        const ownerDigits = String(candidate.wa_phone || '').replace(/\D/g, '');
        const safeLead =
            leadsRes.rows.find((l) => {
                const p = String(l.phone || '').replace(/\D/g, '');
                return p && ownerDigits && (p === ownerDigits || p.endsWith(ownerDigits.slice(-9)));
            }) || leadsRes.rows.find((l) => l.phone && l.email);

        console.log('Leads found:', leadsRes.rows.length);
        if (safeLead) {
            console.log('Test lead:', {
                id: safeLead.id,
                name: safeLead.full_name,
                phone: safeLead.phone ? '***' + String(safeLead.phone).slice(-4) : null,
                email: safeLead.email ? safeLead.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
            });
        }

        if (!SEND) {
            console.log('---');
            console.log('Read-only run complete. Pass --send to run live Gmail + WhatsApp tests.');
            return;
        }

        if (wa.data?.status !== 'connected') {
            console.error('WhatsApp not connected on server — aborting send.');
            process.exit(1);
        }

        console.log('---');
        console.log('Gmail test →', candidate.email);
        try {
            const mail = await sendDynamicEmail(candidate.id, {
                to: candidate.email,
                subject: '[Equipo Experto] Messaging smoke test',
                text: `Smoke test at ${new Date().toISOString()}. If you received this, Gmail dispatch works.`,
                html: `<p>Smoke test at ${new Date().toISOString()}. If you received this, <strong>Gmail dispatch</strong> works.</p>`,
            });
            console.log('Gmail result: OK via', mail.provider, mail.messageId || '');
        } catch (e) {
            console.error('Gmail result: FAILED —', e.message);
        }

        const waTarget = ownerDigits || null;
        if (waTarget) {
            console.log('WhatsApp test → owner phone (via /api/whatsapp/send)');
            const waSend = await api('POST', '/api/whatsapp/send', token, {
                whatsapp_access_token: 'whatsapp_native_session',
                phone: waTarget,
                message: `[Equipo Experto] WhatsApp smoke test ${new Date().toISOString()}`,
            });
            console.log('WhatsApp send result:', waSend.status, waSend.data);
        } else if (safeLead) {
            console.log('WhatsApp + email test → lead trigger');
            const trigger = await api('POST', `/api/leads/${safeLead.id}/trigger`, token, {});
            console.log('Trigger result:', trigger.status, trigger.data);
            if (!trigger.ok) process.exit(1);
        } else {
            console.warn('No automation_id or owner phone — skipped WhatsApp send.');
        }

        console.log('Done. Check inbox, WhatsApp, and Render logs for [WA-Send] / [EmailService].');
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
