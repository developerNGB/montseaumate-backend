import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import pool from '../db/pool.js';
import { signAccessToken } from '../utils/accessToken.js';
import { setJwtCookie } from '../utils/cookieHelpers.js';

const getStripe = () => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    return new Stripe(key);
};

const planIdFromPriceKey = (priceKey) => {
    if (priceKey === 'starter') return 'free';
    if (priceKey === 'growth') return 'Growth';
    if (priceKey === 'pro') return 'Pro';
    return null;
};

const priceIdForKey = (priceKey) => {
    const map = {
        starter: process.env.STRIPE_PRICE_STARTER,
        growth: process.env.STRIPE_PRICE_GROWTH,
        pro: process.env.STRIPE_PRICE_PRO,
    };
    return map[priceKey] || null;
};

/**
 * POST /api/stripe/create-checkout-session
 * Body: { priceKey: 'starter' | 'growth' | 'pro' }
 */
export const createCheckoutSession = async (req, res) => {
    try {
        const stripe = getStripe();
        if (!stripe) {
            return res.status(503).json({
                success: false,
                message: 'Stripe no está configurado. Añade STRIPE_SECRET_KEY y los price IDs en el servidor.',
            });
        }

        const { priceKey } = req.body || {};
        if (!['starter', 'growth', 'pro'].includes(priceKey)) {
            return res.status(400).json({ success: false, message: 'Plan no válido.' });
        }

        const priceId = priceIdForKey(priceKey);
        if (!priceId) {
            return res.status(503).json({
                success: false,
                message: 'Falta configurar STRIPE_PRICE_STARTER, STRIPE_PRICE_GROWTH o STRIPE_PRICE_PRO.',
            });
        }

        const appPlan = planIdFromPriceKey(priceKey);
        const userId = req.user.id;
        const frontend = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${frontend}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontend}/dashboard/settings?tab=billing&checkout=cancelled`,
            client_reference_id: String(userId),
            customer_email: req.user.email || undefined,
            metadata: {
                user_id: String(userId),
                app_plan: appPlan,
                price_key: priceKey,
            },
            subscription_data: {
                metadata: {
                    user_id: String(userId),
                    app_plan: appPlan,
                },
            },
        });

        return res.json({ success: true, url: session.url });
    } catch (err) {
        console.error('[createCheckoutSession]', err.message);
        return res.status(500).json({
            success: false,
            message: 'No se pudo iniciar el pago. Inténtalo de nuevo más tarde.',
        });
    }
};

/**
 * GET /api/stripe/verify-session?session_id=...
 * Confirms payment and upgrades plan if webhook is delayed.
 */
export const verifyCheckoutSession = async (req, res) => {
    try {
        const stripe = getStripe();
        const sessionId = req.query.session_id;
        if (!stripe || !sessionId) {
            return res.status(400).json({ success: false, message: 'Sesión no válida.' });
        }

        const session = await stripe.checkout.sessions.retrieve(String(sessionId));
        const uid = String(req.user.id);
        if (String(session.client_reference_id) !== uid && String(session.metadata?.user_id) !== uid) {
            return res.status(403).json({ success: false, message: 'Esta sesión no pertenece a tu cuenta.' });
        }

        const paid =
            session.payment_status === 'paid' ||
            session.status === 'complete';

        const appPlan = session.metadata?.app_plan;
        if (paid && appPlan) {
            await pool.query(
                `UPDATE users SET plan = $1, trial_ends_at = NULL, updated_at = NOW() WHERE id = $2`,
                [appPlan, req.user.id]
            );
        }

        const userRes = await pool.query(
            `SELECT id, name, email, company_name, phone, plan, role, status, created_at,
                    COALESCE(weekly_reports_enabled, TRUE) AS weekly_reports_enabled,
                    COALESCE(onboarding_completed, FALSE) AS onboarding_completed,
                    trial_ends_at
             FROM users WHERE id = $1`,
            [req.user.id]
        );
        const user = userRes.rows[0];
        if (!user) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        const token = signAccessToken(user);
        setJwtCookie(res, token);

        return res.json({
            success: true,
            paid,
            user,
            token,
        });
    } catch (err) {
        console.error('[verifyCheckoutSession]', err.message);
        return res.status(500).json({ success: false, message: 'No se pudo verificar el pago.' });
    }
};

const buildSupportTransporter = () => {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) return null;
    return nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
    });
};

/**
 * POST /api/webhooks/stripe (raw body)
 */
export const handleStripeWebhook = async (req, res) => {
    const stripe = getStripe();
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !whSecret) {
        return res.status(503).send('Stripe webhook not configured');
    }

    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
    } catch (err) {
        console.error('[Stripe webhook] signature:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.client_reference_id || session.metadata?.user_id;
            const appPlan = session.metadata?.app_plan;
            if (userId && appPlan) {
                await pool.query(
                    `UPDATE users SET plan = $1, trial_ends_at = NULL, updated_at = NOW() WHERE id = $2`,
                    [appPlan, userId]
                );
                console.log(`[Stripe] checkout.session.completed → user ${userId} plan ${appPlan}`);
            }
        }

        if (event.type === 'invoice.payment_failed') {
            const inv = event.data.object;
            const email =
                inv.customer_email ||
                inv.customer_details?.email ||
                inv.customer_name;
            console.warn('[Stripe] invoice.payment_failed', email || inv.id);

            const transport = buildSupportTransporter();
            if (transport && email) {
                const from = `"Equipo Experto" <${process.env.EMAIL_USER}>`;
                await transport
                    .sendMail({
                        from,
                        to: email,
                        subject: 'Problema con tu último pago — Equipo Experto',
                        text:
                            'No pudimos cobrar tu suscripción. Actualiza tu método de pago en Ajustes → Facturación o responde a este correo y te ayudamos.\n\n' +
                            'Si ya has resuelto el pago, puedes ignorar este mensaje en cuanto el banco confirme la operación.',
                    })
                    .catch((e) => console.error('[Stripe] payment_failed email:', e.message));
            }
            const { notifyAdminFireAndForget } = await import('../services/adminAlertService.js');
            notifyAdminFireAndForget({
                subject: `[Equipo Experto] Stripe payment failed — ${email || inv.id}`,
                text: `Invoice payment failed for ${email || 'unknown customer'} (invoice ${inv.id}).`,
            });
        }
    } catch (err) {
        console.error('[Stripe webhook] handler:', err.message);
        return res.status(500).json({ received: false });
    }

    return res.json({ received: true });
};
