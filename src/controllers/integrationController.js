import pool from '../db/pool.js';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { backendBaseUrl, frontendBaseUrl } from '../utils/publicUrls.js';
import * as whatsappService from '../services/whatsappService.js';
import { getValidGoogleTokens } from '../utils/googleAuth.js';

// Mock OAuth Credentials
const MOCK_CLIENT_ID = 'mock_client_id';
const OAUTH_CONNECT_TICKET_TTL_MINUTES = 10;
const GENERIC_EMAIL_DOMAINS = new Set([
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'yahoo.com',
    'icloud.com',
    'me.com',
    'aol.com',
    'proton.me',
    'protonmail.com',
]);

function normalizeText(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function tokenize(value = '') {
    return normalizeText(value)
        .split(' ')
        .filter(Boolean);
}

function extractDomain(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    try {
        const host = raw.includes('://') ? new URL(raw).hostname : raw;
        return host.replace(/^www\./, '');
    } catch {
        return raw.replace(/^www\./, '');
    }
}

function scoreBusinessLocation(location, { companyName = '', email = '' } = {}) {
    const title = String(location?.title || '');
    const normalizedTitle = normalizeText(title);
    const normalizedCompany = normalizeText(companyName);
    let score = 0;

    if (normalizedCompany && normalizedTitle) {
        if (normalizedTitle === normalizedCompany) {
            score += 120;
        } else if (normalizedTitle.includes(normalizedCompany) || normalizedCompany.includes(normalizedTitle)) {
            score += 70;
        }

        const titleTokens = new Set(tokenize(title));
        const companyTokens = tokenize(companyName);
        const overlap = companyTokens.filter((token) => titleTokens.has(token)).length;
        score += overlap * 12;
    }

    const emailDomain = extractDomain(String(email).split('@')[1] || '');
    const websiteDomain = extractDomain(location?.websiteUri || '');
    if (
        emailDomain &&
        websiteDomain &&
        !GENERIC_EMAIL_DOMAINS.has(emailDomain) &&
        (websiteDomain === emailDomain || websiteDomain.endsWith(`.${emailDomain}`) || emailDomain.endsWith(`.${websiteDomain}`))
    ) {
        score += 45;
    }

    if (location?.metadata?.newReviewUri) score += 20;
    return score;
}

async function fetchGoogleJson(url, accessToken) {
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-GOOG-API-FORMAT-VERSION': '2',
        },
    });

    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }

    return { response, data };
}

async function findGoogleBusinessReviewLink({ userId, companyName = '', email = '' }) {
    const { access_token: accessToken } = await getValidGoogleTokens(userId);
    if (!accessToken) {
        return { ok: false, code: 'GOOGLE_TOKEN_UNAVAILABLE', reason: 'token_unavailable' };
    }

    const accountsResult = await fetchGoogleJson(
        'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
        accessToken
    );

    if (!accountsResult.response.ok) {
        const errorMessage = accountsResult.data?.error?.message || '';
        const code =
            accountsResult.response.status === 403
                ? 'GBP_SCOPE_OR_API_UNAVAILABLE'
                : 'GBP_ACCOUNTS_FETCH_FAILED';
        return {
            ok: false,
            code,
            status: accountsResult.response.status,
            reason: errorMessage || 'accounts_fetch_failed',
        };
    }

    const accounts = Array.isArray(accountsResult.data?.accounts) ? accountsResult.data.accounts : [];
    const candidates = [];

    for (const account of accounts) {
        const accountName = String(account?.name || '').trim();
        if (!accountName) continue;

        let nextPageToken = '';
        let pageGuard = 0;

        do {
            const params = new URLSearchParams({
                readMask: 'title,websiteUri,metadata',
                pageSize: '100',
            });
            if (nextPageToken) params.set('pageToken', nextPageToken);

            const locationsResult = await fetchGoogleJson(
                `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?${params.toString()}`,
                accessToken
            );

            if (!locationsResult.response.ok) {
                nextPageToken = '';
                break;
            }

            const locations = Array.isArray(locationsResult.data?.locations) ? locationsResult.data.locations : [];
            for (const location of locations) {
                if (!location?.metadata?.newReviewUri) continue;
                candidates.push({
                    accountName: account.accountName || account.name,
                    title: location.title || '',
                    websiteUri: location.websiteUri || '',
                    reviewUrl: location.metadata.newReviewUri,
                    mapsUri: location.metadata.mapsUri || '',
                    placeId: location.metadata.placeId || '',
                    score: scoreBusinessLocation(location, { companyName, email }),
                });
            }

            nextPageToken = String(locationsResult.data?.nextPageToken || '').trim();
            pageGuard += 1;
        } while (nextPageToken && pageGuard < 10);
    }

    if (!candidates.length) {
        return { ok: false, code: 'GBP_NO_LOCATIONS', reason: 'no_locations' };
    }

    candidates.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const best = candidates[0];
    const second = candidates[1];
    const isSingleCandidate = candidates.length === 1;
    const isConfidentMatch =
        best.score >= 90 ||
        (best.score >= 60 && (!second || best.score - second.score >= 25));

    if (!isSingleCandidate && !isConfidentMatch) {
        return {
            ok: false,
            code: 'GBP_AMBIGUOUS',
            reason: 'ambiguous',
            candidates: candidates.slice(0, 5).map((candidate) => ({
                title: candidate.title,
                reviewUrl: candidate.reviewUrl,
                mapsUri: candidate.mapsUri,
            })),
        };
    }

    return {
        ok: true,
        source: 'google_business_profile',
        reviewUrl: best.reviewUrl,
        businessName: best.title,
        mapsUri: best.mapsUri,
        placeId: best.placeId,
        matchedBy: isSingleCandidate ? 'single_location' : 'best_match',
    };
}

async function ensureOAuthConnectTicketsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS oauth_connect_tickets (
            ticket VARCHAR(128) PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider VARCHAR(50) NOT NULL,
            job_id VARCHAR(100),
            used BOOLEAN DEFAULT FALSE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
}

function buildFrontendRedirect(baseUrl, jobId = '') {
    const configPaths = {
        'config-capture': '/dashboard/config/lead-capture',
        'config-followup': '/dashboard/config/lead-followup',
        'config-review': '/dashboard/config/review-funnel',
    };
    if (jobId === 'onboarding') return `${baseUrl}/dashboard/integrations`;
    if (jobId && configPaths[jobId]) return `${baseUrl}${configPaths[jobId]}`;
    if (jobId) return `${baseUrl}/dashboard/employee/${jobId}`;
    return `${baseUrl}/dashboard/integrations`;
}

export const createConnectTicket = async (req, res) => {
    try {
        const { provider } = req.params;
        const { jobId = '' } = req.body || {};

        if (!['google', 'microsoft', 'whatsapp'].includes(provider)) {
            return res.status(400).json({ success: false, message: 'Invalid Provider' });
        }

        await ensureOAuthConnectTicketsTable();

        const ticket = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + OAUTH_CONNECT_TICKET_TTL_MINUTES * 60 * 1000);
        await pool.query(
            `INSERT INTO oauth_connect_tickets (ticket, user_id, provider, job_id, expires_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [ticket, req.user.id, provider, String(jobId || '').trim() || null, expiresAt]
        );

        const apiBase = backendBaseUrl();
        if (!apiBase) {
            return res.status(500).json({ success: false, message: 'Server misconfiguration: set BACKEND_URL' });
        }

        return res.status(200).json({
            success: true,
            url: `${apiBase}/api/integrations/${provider}/connect?ticket=${encodeURIComponent(ticket)}`,
        });
    } catch (err) {
        console.error('[createConnectTicket] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * GET /api/integrations
 * Fetch all active integrations for the logged-in user
 */
export const getIntegrations = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, provider, account_id, created_at, updated_at FROM integrations WHERE user_id = $1',
            [req.user.id]
        );
        return res.status(200).json({ success: true, integrations: result.rows });
    } catch (err) {
        console.error('[getIntegrations] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const getGoogleReviewLinkSuggestion = async (req, res) => {
    try {
        const integrationRes = await pool.query(
            'SELECT id FROM integrations WHERE user_id = $1 AND provider = $2 LIMIT 1',
            [req.user.id, 'google']
        );
        if (integrationRes.rows.length === 0) {
            return res.status(404).json({
                success: false,
                code: 'GOOGLE_NOT_CONNECTED',
                message: 'Google is not connected for this user.',
            });
        }

        const userRes = await pool.query(
            'SELECT company_name, name, email FROM users WHERE id = $1 LIMIT 1',
            [req.user.id]
        );
        const user = userRes.rows[0] || {};
        const companyName = String(user.company_name || user.name || '').trim();
        const email = String(user.email || '').trim();

        const result = await findGoogleBusinessReviewLink({
            userId: req.user.id,
            companyName,
            email,
        });

        if (!result.ok) {
            const status =
                result.code === 'GOOGLE_TOKEN_UNAVAILABLE' ? 401 :
                result.code === 'GBP_SCOPE_OR_API_UNAVAILABLE' ? 403 :
                result.code === 'GBP_NO_LOCATIONS' ? 404 :
                result.code === 'GBP_AMBIGUOUS' ? 409 : 502;
            return res.status(status).json({
                success: false,
                ...result,
            });
        }

        return res.status(200).json({
            success: true,
            ...result,
        });
    } catch (err) {
        console.error('[getGoogleReviewLinkSuggestion] Error:', err.message);
        return res.status(500).json({
            success: false,
            code: 'REVIEW_LINK_SUGGESTION_FAILED',
            message: 'Could not resolve Google review link automatically.',
        });
    }
};

/**
 * GET /api/integrations/:provider/connect
 * Redirects the user to the OAuth Provider
 * Expects ?ticket=ONE_TIME_SERVER_TICKET
 */
export const connectProvider = async (req, res) => {
    try {
        const { provider } = req.params;
        const { ticket } = req.query;

        if (!ticket) {
            return res.status(401).send('Unauthorized: No connect ticket provided');
        }

        await ensureOAuthConnectTicketsTable();
        const ticketRes = await pool.query(
            `SELECT user_id, provider, job_id
             FROM oauth_connect_tickets
             WHERE ticket = $1 AND provider = $2 AND used = FALSE AND expires_at > NOW()
             LIMIT 1`,
            [String(ticket), provider]
        );
        if (ticketRes.rows.length === 0) {
            return res.status(401).send('Unauthorized: Invalid or expired connect ticket');
        }

        const state = String(ticket);

        const apiBase = backendBaseUrl();
        if (!apiBase) {
            console.error('[connectProvider] BACKEND_URL is not set');
            return res.status(500).send('Server misconfiguration: set BACKEND_URL');
        }
        const callbackUrl = `${apiBase}/api/integrations/${provider}/callback`;

        if (provider === 'google') {
            const clientId = process.env.GOOGLE_CLIENT_ID;
            if (clientId) {
                // Real Google OAuth2 â€” least privilege: send mail only (no inbox read / full Gmail)
                // gmail.send â†’ Gmail API users.messages.send (see emailService.js)
                // email + profile â†’ oauth2 userinfo for connected account display
                // Note: automatic "reply detected" inbox scanning (followupCron) needs readonly and is skipped if list returns 403.
                const scopes = [
                    'openid',
                    'https://www.googleapis.com/auth/userinfo.email',
                    'https://www.googleapis.com/auth/userinfo.profile',
                    'https://www.googleapis.com/auth/gmail.send',
                ];
                if (String(process.env.GOOGLE_BUSINESS_PROFILE_SCOPE || '').trim().toLowerCase() === 'true') {
                    scopes.push('https://www.googleapis.com/auth/business.manage');
                }
                const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(callbackUrl)}&response_type=code&scope=${encodeURIComponent(scopes.join(' '))}&access_type=offline&prompt=consent&state=${encodeURIComponent(state)}`;
                return res.redirect(authUrl);
            } else {
                // Mock OAuth Redirect
                return res.redirect(`/api/integrations/mock-oauth?provider=google&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(callbackUrl)}`);
            }
        }
        else if (provider === 'microsoft') {
            const clientId = process.env.MICROSOFT_CLIENT_ID;
            if (clientId) {
                // Real Microsoft OAuth Redirect
                const scopes = 'offline_access user.read mail.send mail.readwrite';
                const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${callbackUrl}&response_mode=query&scope=${encodeURIComponent(scopes)}&state=${state}`;
                return res.redirect(authUrl);
            } else {
                return res.redirect(`/api/integrations/mock-oauth?provider=microsoft&state=${state}&redirect_uri=${callbackUrl}`);
            }
        }
        else if (provider === 'whatsapp') {
            const clientId = process.env.META_CLIENT_ID;
            if (clientId) {
                // Real Meta/WhatsApp OAuth Redirect
                const authUrl = `https://www.facebook.com/v17.0/dialog/oauth?client_id=${clientId}&redirect_uri=${callbackUrl}&state=${state}&scope=whatsapp_business_management,whatsapp_business_messaging`;
                return res.redirect(authUrl);
            } else {
                // Mock OAuth Redirect
                return res.redirect(`/api/integrations/mock-oauth?provider=whatsapp&state=${state}&redirect_uri=${callbackUrl}`);
            }
        }
        else {
            return res.status(400).send('Invalid Provider');
        }

    } catch (err) {
        console.error('[connectProvider] Error:', err.message);
        return res.status(500).send('Server Error');
    }
};

/**
 * GET /api/integrations/:provider/callback
 * Handles the OAuth callback from the Provider
 */
export const providerCallback = async (req, res) => {
    try {
        const { provider } = req.params;
        const { code, state, error } = req.query;

        const BASE = frontendBaseUrl();
        if (!BASE) {
            console.error('[providerCallback] FRONTEND_URL is not set');
            return res.status(500).send('Server misconfiguration: set FRONTEND_URL');
        }

        await ensureOAuthConnectTicketsTable();
        const ticket = String(state || '').trim();
        const ticketRes = ticket
            ? await pool.query(
                  `SELECT user_id, job_id
                   FROM oauth_connect_tickets
                   WHERE ticket = $1 AND provider = $2 AND used = FALSE AND expires_at > NOW()
                   LIMIT 1`,
                  [ticket, provider]
              )
            : { rows: [] };
        const ticketRow = ticketRes.rows[0] || null;
        const jobId = ticketRow?.job_id || '';
        const frontendRedirect = buildFrontendRedirect(BASE, jobId);

        if (error) {
            console.error(`[${provider} OAuth Error]:`, error);
            return res.redirect(`${frontendRedirect}?error=oauth_failed`);
        }

        if (!code || !state) {
            return res.redirect(`${frontendRedirect}?error=invalid_callback`);
        }

        if (!ticketRow) {
            return res.redirect(`${frontendRedirect}?error=invalid_state`);
        }

        const userId = ticketRow.user_id;
        let accessToken = '';
        let refreshToken = '';
        let accountId = '';
        let expiresAt = null;

        const apiBase = backendBaseUrl();
        if (!apiBase) {
            console.error('[providerCallback] BACKEND_URL is not set');
            return res.redirect(`${frontendRedirect}?error=server_error&details=${encodeURIComponent('BACKEND_URL is not set')}`);
        }
        const callbackUrl = `${apiBase}/api/integrations/${provider}/callback`;

        let metadata = {};

        // 1. Exchange 'code' for tokens based on the provider
        if (provider === 'google' && process.env.GOOGLE_CLIENT_ID) {
            console.log(`[Google OAuth] Exchanging code. callbackUrl=${callbackUrl}`);

            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: callbackUrl
                }).toString()
            });

            if (!tokenResponse.ok) {
                const rawText = await tokenResponse.text();
                console.error(`[Google Token HTTP ${tokenResponse.status}]:`, rawText);
                throw new Error(`Google token HTTP ${tokenResponse.status}: ${rawText.slice(0, 200)}`);
            }

            const tokenData = await tokenResponse.json();
            console.log('[Google Token Response]:', JSON.stringify(tokenData, null, 2));

            if (tokenData.error) {
                throw new Error(`Google token error: ${tokenData.error} â€” ${tokenData.error_description || 'No description'}`);
            }

            if (!tokenData.access_token) {
                throw new Error(`Google token exchange returned no access_token. Response: ${JSON.stringify(tokenData)}`);
            }

            accessToken = tokenData.access_token;
            refreshToken = tokenData.refresh_token || null;

            // Fetch connected Google account email
            try {
                const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                const userData = await userRes.json();
                console.log('[Google UserInfo]:', JSON.stringify(userData));
                if (userData.email) {
                    metadata.email = userData.email;
                    accountId = `gmail:${userData.email}`;
                } else {
                    accountId = 'Gmail Connected';
                }
            } catch (e) {
                console.error('[Google UserInfo Error]:', e.message);
                accountId = 'Gmail Connected';
            }

            if (tokenData.expires_in) {
                expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
            }

        } else if (provider === 'microsoft' && process.env.MICROSOFT_CLIENT_ID) {
            // Real Microsoft Token Exchange
            const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, // fixed typo: was x-form-urlencoded
                body: new URLSearchParams({
                    client_id: process.env.MICROSOFT_CLIENT_ID,
                    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: callbackUrl
                })
            });
            const tokenData = await tokenResponse.json();
            if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

            accessToken = tokenData.access_token;
            refreshToken = tokenData.refresh_token || null;
            
            // FETCH MICROSOFT EMAIL
            try {
                const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                const meData = await meRes.json();
                metadata.email = meData.mail || meData.userPrincipalName;
                accountId = 'Microsoft Account Connected';
            } catch (e) {
                console.error('[Microsoft Graph Error]:', e);
                accountId = 'Microsoft Account Connected';
            }

            if (tokenData.expires_in) {
                expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
            }

        } else if (provider === 'whatsapp' && process.env.META_CLIENT_ID) {
            // Real Meta Token Exchange
            const tokenResponse = await fetch(`https://graph.facebook.com/v17.0/oauth/access_token?client_id=${process.env.META_CLIENT_ID}&redirect_uri=${callbackUrl}&client_secret=${process.env.META_CLIENT_SECRET}&code=${code}`);
            const tokenData = await tokenResponse.json();
            if (tokenData.error) throw new Error(tokenData.error.message);

            accessToken = tokenData.access_token;
            refreshToken = null;
            accountId = 'meta_business_account';

            if (tokenData.expires_in) {
                expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
            }

        } else {
            // Processing Mock Tokens
            if (code === 'mock_auth_code_approved') {
                accessToken = `mock_${provider}_access_token_${Date.now()}`;
                refreshToken = `mock_${provider}_refresh_token_never_expires`;
                metadata.email = `mock_${provider}_user@example.com`;
                // Provide a mock review link for Google
                accountId = provider === 'google' 
                    ? 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4' 
                    : `mock_${provider}_account_id`;
                expiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour
            } else {
                return res.redirect(`${frontendRedirect}?error=mock_auth_failed`);
            }
        }

        // 2. Save Integration in Database (Upsert: Update if exists, Insert if new)
        await pool.query(
            `INSERT INTO integrations (user_id, provider, access_token, refresh_token, expires_at, account_id, metadata, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT (user_id, provider) 
             DO UPDATE SET 
                access_token = EXCLUDED.access_token,
                refresh_token = COALESCE(EXCLUDED.refresh_token, integrations.refresh_token),
                expires_at = EXCLUDED.expires_at,
                account_id = EXCLUDED.account_id,
                metadata = EXCLUDED.metadata,
                updated_at = NOW()`,
            [userId, provider, accessToken, refreshToken, expiresAt, accountId, JSON.stringify(metadata)]
        );
        await pool.query('UPDATE oauth_connect_tickets SET used = TRUE WHERE ticket = $1', [ticket]);

        // 3. Redirect user back to the dashboard integrations tab successfully
        return res.redirect(`${frontendRedirect}?success=connected`);

    } catch (err) {
        const errMsg = err?.message || err?.toString() || 'Unknown server error';
        console.error('[providerCallback] CRITICAL ERROR:', errMsg);
        if (err?.stack) console.error('[providerCallback] Stack:', err.stack);

        // Extract jobId for fallback redirect
        const baseUrl = frontendBaseUrl();
        if (!baseUrl) {
            return res.status(500).send('Server misconfiguration: set FRONTEND_URL');
        }
        let jobId = '';
        try {
            await ensureOAuthConnectTicketsTable();
            const ticket = String(req.query.state || '').trim();
            if (ticket) {
                const fallbackTicket = await pool.query(
                    'SELECT job_id FROM oauth_connect_tickets WHERE ticket = $1 LIMIT 1',
                    [ticket]
                );
                jobId = fallbackTicket.rows[0]?.job_id || '';
            }
        } catch {
            /* noop */
        }
        const frontendRedirect = buildFrontendRedirect(baseUrl, jobId);

        return res.redirect(`${frontendRedirect}?error=server_error&details=${encodeURIComponent(errMsg)}`);
    }
};

/**
 * GET /api/integrations/health
 * Connection health for dashboard alerts (WhatsApp + Gmail).
 */
export const getIntegrationHealth = async (req, res) => {
    try {
        const userId = req.user.id;
        const issues = [];

        const intRes = await pool.query(
            `SELECT provider, account_id, metadata FROM integrations WHERE user_id = $1`,
            [userId]
        );
        const byProvider = Object.fromEntries(intRes.rows.map((r) => [r.provider, r]));

        let whatsapp = { linked: false, status: 'disconnected', ok: true };
        const waRow = byProvider.whatsapp;
        if (waRow?.access_token === 'whatsapp_native_session') {
            whatsapp.linked = true;
            const session = whatsappService.getSessionStatus(userId);
            whatsapp.status = session.status || 'disconnected';
            whatsapp.ok = session.status === 'connected';
            if (!whatsapp.ok) {
                issues.push({
                    code: 'whatsapp_disconnected',
                    severity: 'warning',
                    integration: 'whatsapp',
                });
            }
        }

        let gmail = { linked: false, email: null, ok: true };
        const googleRow = byProvider.google;
        if (googleRow) {
            gmail.linked = true;
            let meta = googleRow.metadata;
            if (typeof meta === 'string') {
                try {
                    meta = JSON.parse(meta);
                } catch {
                    meta = {};
                }
            }
            gmail.email = meta?.email || googleRow.account_id?.replace(/^gmail:/, '') || null;
            const { access_token } = await getValidGoogleTokens(userId);
            gmail.ok = Boolean(access_token);
            if (!gmail.ok) {
                issues.push({
                    code: 'gmail_disconnected',
                    severity: 'warning',
                    integration: 'gmail',
                });
            }
        }

        const smtpRes = await pool.query(
            'SELECT id FROM smtp_settings WHERE user_id = $1 AND is_active = true LIMIT 1',
            [userId]
        );
        const smtpActive = smtpRes.rows.length > 0;
        const canSendEmail = gmail.ok || smtpActive || Boolean(byProvider.microsoft);

        if (!canSendEmail && (gmail.linked || smtpActive)) {
            issues.push({
                code: 'email_send_blocked',
                severity: 'warning',
                integration: 'gmail',
            });
        }

        return res.status(200).json({
            success: true,
            whatsapp,
            gmail,
            smtpActive,
            canSendEmail,
            issues,
            hasIssues: issues.length > 0,
        });
    } catch (err) {
        console.error('[getIntegrationHealth] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Could not check integrations.' });
    }
};

/**
 * DELETE /api/integrations/:provider
 * Remove an integration
 */
export const disconnectProvider = async (req, res) => {
    try {
        const { provider } = req.params;
        await pool.query('DELETE FROM integrations WHERE user_id = $1 AND provider = $2', [req.user.id, provider]);
        return res.status(200).json({ success: true, message: 'Integration removed successfully' });
    } catch (err) {
        console.error('[disconnectProvider] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * GET /api/integrations/mock-oauth
 * Renders a simple HTML page to mock the OAuth Consent Screen
 */
export const renderMockOAuth = (req, res) => {
    const { provider, state, redirect_uri } = req.query;

    const approveUrl = `${redirect_uri}?state=${state}&code=mock_auth_code_approved`;
    const denyUrl = `${redirect_uri}?state=${state}&error=access_denied`;

    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Mock ${provider.toUpperCase()} Authorization</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); text-align: center; max-width: 400px; width: 100%; }
                h1 { margin-top: 0; font-size: 24px; color: #111827; }
                p { color: #4b5563; margin-bottom: 30px; line-height: 1.5; }
                .provider { font-weight: bold; color: #0ea5e9; text-transform: capitalize; }
                .btn { display: block; width: 100%; padding: 12px; margin-bottom: 15px; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; text-decoration: none; box-sizing: border-box; }
                .btn-approve { background-color: #0ea5e9; color: white; }
                .btn-approve:hover { background-color: #0284c7; }
                .btn-deny { background-color: #f3f4f6; color: #374151; border: 1px solid #d1d5db; }
                .btn-deny:hover { background-color: #e5e7eb; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Grant Permission</h1>
                <p><strong>Equipo Experto</strong> wants to access your <span class="provider">${provider}</span> account to perform actions on your behalf.</p>
                
                <a href="${approveUrl}" class="btn btn-approve">Allow Access</a>
                <a href="${denyUrl}" class="btn btn-deny">Deny</a>
                
                <p style="font-size: 12px; color: #9ca3af; margin-bottom: 0;">
                    (This is a mock OAuth screen because real credentials were not provided in .env)
                </p>
            </div>
        </body>
        </html>
    `;
    res.send(html);
};



