import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import pool from '../db/pool.js';
import { signAccessToken } from '../utils/accessToken.js';
import { setJwtCookie } from '../utils/cookieHelpers.js';
import { enrichUserForClient } from '../utils/billingAccess.js';
import { resolveBillingForEntitlements } from '../services/subscriptionPlans.js';
import { isAdminUser } from '../utils/adminAccess.js';

const getStripe = () => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    return new Stripe(key);
};

const isStripeConfigured = () =>
    !!(
        process.env.STRIPE_SECRET_KEY &&
        process.env.STRIPE_PRICE_STARTER &&
        process.env.STRIPE_PRICE_GROWTH &&
        process.env.STRIPE_PRICE_PRO
    );

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

const planFromStripePriceId = (priceId) => {
    if (!priceId) return null;
    if (priceId === process.env.STRIPE_PRICE_STARTER) return 'free';
    if (priceId === process.env.STRIPE_PRICE_GROWTH) return 'Growth';
    if (priceId === process.env.STRIPE_PRICE_PRO) return 'Pro';
    return null;
};

const frontendBaseUrl = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const stripeCheckoutIdempotencyBucketMs = 15 * 60 * 1000;

/** Free trial days on Stripe Checkout (card collected today, first charge after trial). Default 30. Set 0 to disable. */
const stripeTrialDays = () => {
    const n = parseInt(process.env.STRIPE_TRIAL_DAYS ?? '30', 10);
    if (!Number.isFinite(n) || n < 0) return 30;
    return Math.min(Math.max(n, 0), 90);
};

async function persistStripeBilling(userId, { customerId, subscriptionId, appPlan }) {
    const sets = [];
    const vals = [];
    let i = 1;

    if (appPlan) {
        sets.push(`plan = $${i++}`);
        vals.push(appPlan);
        sets.push('trial_ends_at = NULL');
    }
    if (customerId) {
        sets.push(`stripe_customer_id = COALESCE(stripe_customer_id, $${i++})`);
        vals.push(String(customerId));
    }
    if (subscriptionId !== undefined) {
        sets.push(`stripe_subscription_id = $${i++}`);
        vals.push(subscriptionId ? String(subscriptionId) : null);
    }
    sets.push('updated_at = NOW()');
    vals.push(userId);

    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

/**
 * GET /api/stripe/billing-status
 */
export const getBillingStatus = async (req, res) => {
    try {
        const configured = isStripeConfigured();
        const row = await pool.query(
            `SELECT plan, trial_ends_at, email, role, stripe_customer_id, stripe_subscription_id
             FROM users WHERE id = $1`,
            [req.user.id]
        );
        const u = row.rows[0];
        const billing = resolveBillingForEntitlements(
            req.user,
            u?.plan,
            u?.trial_ends_at
        );
        return res.json({
            success: true,
            configured,
            plan: billing.plan,
            is_admin: isAdminUser(req.user),
            canManagePortal: configured && !!u?.stripe_customer_id && !isAdminUser(req.user),
            hasStripeSubscription: !!u?.stripe_subscription_id || isAdminUser(req.user),
        });
    } catch (err) {
        console.error('[getBillingStatus]', err.message);
        return res.status(500).json({ success: false, code: 'stripe_billing_status_failed' });
    }
};

/**
 * POST /api/stripe/create-portal-session
 */
export const createPortalSession = async (req, res) => {
    try {
        const stripe = getStripe();
        if (!stripe) {
            return res.status(503).json({ success: false, code: 'stripe_not_configured' });
        }

        const row = await pool.query(
            'SELECT stripe_customer_id FROM users WHERE id = $1',
            [req.user.id]
        );
        const customerId = row.rows[0]?.stripe_customer_id;
        if (!customerId) {
            return res.status(400).json({ success: false, code: 'stripe_no_customer' });
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${frontendBaseUrl()}/dashboard/settings?tab=billing`,
        });

        return res.json({ success: true, url: session.url });
    } catch (err) {
        console.error('[createPortalSession]', err.message);
        return res.status(500).json({ success: false, code: 'stripe_portal_failed' });
    }
};

/**
 * POST /api/stripe/create-checkout-session
 * Body: { priceKey: 'starter' | 'growth' | 'pro' }
 */
export const createCheckoutSession = async (req, res) => {
    try {
        const { priceKey, cancelContext } = req.body || {};
        if (!['starter', 'growth', 'pro'].includes(priceKey)) {
            return res.status(400).json({ success: false, code: 'stripe_invalid_plan' });
        }

        const stripe = getStripe();
        if (!stripe) {
            // Stripe is not configured on the server.
            // Dynamically activate the selected plan in the DB and redirect to /dashboard
            const appPlan = planIdFromPriceKey(priceKey);
            const userId = req.user.id;

            await pool.query(
                `UPDATE users SET plan = $1, trial_ends_at = NOW() + INTERVAL '30 days', updated_at = NOW()
                 WHERE id = $2`,
                [appPlan, userId]
            );

            // Fetch the updated user profile
            const userRes = await pool.query(
                `SELECT id, name, email, company_name, phone, plan, role, status, created_at,
                        COALESCE(weekly_reports_enabled, TRUE) AS weekly_reports_enabled,
                        COALESCE(onboarding_completed, FALSE) AS onboarding_completed,
                        trial_ends_at, stripe_subscription_id, stripe_customer_id
                 FROM users WHERE id = $1`,
                [userId]
            );
            const user = userRes.rows[0];
            const token = signAccessToken(user);
            setJwtCookie(res, token);

            return res.json({
                success: true,
                url: `${frontendBaseUrl()}/dashboard`,
                token,
                user: enrichUserForClient(user),
            });
        }

        const priceId = priceIdForKey(priceKey);
        if (!priceId) {
            return res.status(503).json({
                success: false,
                code: 'stripe_price_ids_missing',
            });
        }

        const appPlan = planIdFromPriceKey(priceKey);
        const userId = req.user.id;
        const frontend = frontendBaseUrl();
        const idempotencyBucket = Math.floor(Date.now() / stripeCheckoutIdempotencyBucketMs);
        const checkoutIdempotencyKey = `checkout:${userId}:${priceKey}:${idempotencyBucket}`;

        let userRow;
        try {
            userRow = await pool.query(
                'SELECT email, stripe_customer_id FROM users WHERE id = $1',
                [userId]
            );
        } catch (dbErr) {
            if (dbErr.code === '42703') {
                console.error('[createCheckoutSession] users.stripe_customer_id column missing — redeploy latest API');
                return res.status(503).json({
                    success: false,
                    code: 'stripe_db_schema',
                    message: 'Billing database columns are missing. Redeploy the API or run db:init.',
                });
            }
            throw dbErr;
        }
        const existingCustomerId = userRow.rows[0]?.stripe_customer_id;

        const sessionParams = {
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${frontend}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontend}/checkout/${priceKey}?cancelled=1${cancelContext === 'settings' ? '&from=settings' : ''}`,
            client_reference_id: String(userId),
            metadata: {
                user_id: String(userId),
                app_plan: appPlan,
                price_key: priceKey,
            },
            subscription_data: {
                metadata: {
                    user_id: String(userId),
                    app_plan: appPlan,
                    price_key: priceKey,
                },
                ...(stripeTrialDays() > 0
                    ? { trial_period_days: stripeTrialDays() }
                    : {}),
            },
        };

        if (existingCustomerId) {
            sessionParams.customer = existingCustomerId;
        } else {
            sessionParams.customer_email = req.user.email || userRow.rows[0]?.email || undefined;
        }

        let session;
        try {
            session = await stripe.checkout.sessions.create(sessionParams, {
                idempotencyKey: checkoutIdempotencyKey,
            });
        } catch (stripeErr) {
            const msg = stripeErr?.raw?.message || stripeErr?.message || 'Stripe error';
            console.error('[createCheckoutSession] Stripe:', msg, stripeErr?.code);

            // Stale customer from old Stripe account — retry without customer id
            if (
                existingCustomerId &&
                (stripeErr?.code === 'resource_missing' ||
                    /no such customer/i.test(msg))
            ) {
                delete sessionParams.customer;
                sessionParams.customer_email =
                    req.user.email || userRow.rows[0]?.email || undefined;
                session = await stripe.checkout.sessions.create(sessionParams, {
                    idempotencyKey: `${checkoutIdempotencyKey}:nocustomer`,
                });
                await pool.query(
                    'UPDATE users SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = $1',
                    [userId]
                );
            } else {
                const hint =
                    /no such price/i.test(msg) || stripeErr?.code === 'resource_missing'
                        ? 'stripe_price_invalid'
                        : /api key/i.test(msg)
                          ? 'stripe_key_invalid'
                          : 'stripe_checkout_failed';
                return res.status(400).json({
                    success: false,
                    code: hint,
                    message:
                        hint === 'stripe_price_invalid'
                            ? 'Stripe price ID does not match this API key (test vs live, or wrong price_ id in Render).'
                            : hint === 'stripe_key_invalid'
                              ? 'Invalid STRIPE_SECRET_KEY on the server.'
                              : 'Could not start checkout. Check Stripe keys and price IDs on Render.',
                });
            }
        }

        return res.json({ success: true, url: session.url });
    } catch (err) {
        console.error('[createCheckoutSession]', err.message, err.code);
        return res.status(500).json({
            success: false,
            code: 'stripe_checkout_failed',
            message: err.code === '42703'
                ? 'Billing database columns are missing. Redeploy the API.'
                : 'Could not start checkout. Please try again.',
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
            return res.status(400).json({ success: false, code: 'stripe_session_invalid' });
        }

        const session = await stripe.checkout.sessions.retrieve(String(sessionId), {
            expand: ['subscription'],
        });
        const uid = String(req.user.id);
        if (String(session.client_reference_id) !== uid && String(session.metadata?.user_id) !== uid) {
            return res.status(403).json({ success: false, code: 'stripe_session_forbidden' });
        }

        const paid =
            session.payment_status === 'paid' ||
            session.payment_status === 'no_payment_required' ||
            session.status === 'complete';

        const appPlan = session.metadata?.app_plan;
        if (paid && appPlan) {
            const subscriptionId =
                typeof session.subscription === 'string'
                    ? session.subscription
                    : session.subscription?.id ?? null;
            await persistStripeBilling(req.user.id, {
                appPlan,
                customerId: session.customer,
                subscriptionId,
            });
        }

        const userRes = await pool.query(
            `SELECT id, name, email, company_name, phone, plan, role, status, created_at,
                    COALESCE(weekly_reports_enabled, TRUE) AS weekly_reports_enabled,
                    COALESCE(onboarding_completed, FALSE) AS onboarding_completed,
                    trial_ends_at, stripe_subscription_id, stripe_customer_id
             FROM users WHERE id = $1`,
            [req.user.id]
        );
        const user = userRes.rows[0];
        if (!user) {
            return res.status(404).json({ success: false, code: 'stripe_user_not_found' });
        }

        const token = signAccessToken(user);
        setJwtCookie(res, token);

        return res.json({
            success: true,
            paid,
            user: enrichUserForClient(user),
        });
    } catch (err) {
        console.error('[verifyCheckoutSession]', err.message);
        return res.status(500).json({ success: false, code: 'stripe_verify_failed' });
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

async function handleSubscriptionLifecycle(subscription, eventType) {
    const userId = subscription.metadata?.user_id;
    if (!userId) return;

    const canceled =
        eventType === 'customer.subscription.deleted' ||
        subscription.status === 'canceled' ||
        subscription.status === 'unpaid';

    if (canceled) {
        await persistStripeBilling(userId, {
            appPlan: 'free',
            subscriptionId: null,
        });
        console.log(`[Stripe] subscription ended → user ${userId} plan free`);
        return;
    }

    if (['active', 'trialing', 'past_due'].includes(subscription.status)) {
        const priceId = subscription.items?.data?.[0]?.price?.id;
        const appPlan =
            planFromStripePriceId(priceId) || subscription.metadata?.app_plan || null;
        if (appPlan) {
            await persistStripeBilling(userId, {
                appPlan,
                customerId: subscription.customer,
                subscriptionId: subscription.id,
            });
            console.log(`[Stripe] subscription ${subscription.status} → user ${userId} plan ${appPlan}`);
        }
    }
}

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
                await persistStripeBilling(userId, {
                    appPlan,
                    customerId: session.customer,
                    subscriptionId: session.subscription,
                });
                console.log(`[Stripe] checkout.session.completed → user ${userId} plan ${appPlan}`);
            }
        }

        if (
            event.type === 'customer.subscription.updated' ||
            event.type === 'customer.subscription.deleted'
        ) {
            await handleSubscriptionLifecycle(event.data.object, event.type);
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
