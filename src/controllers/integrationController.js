import pool from '../db/pool.js';
import jwt from 'jsonwebtoken';

// Mock OAuth Credentials
const MOCK_CLIENT_ID = 'mock_client_id';

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

/**
 * GET /api/integrations/:provider/connect
 * Redirects the user to the OAuth Provider
 * Expects ?token=YOUR_JWT or passed via header if possible (we use query for redirects)
 */
export const connectProvider = async (req, res) => {
    try {
        const { provider } = req.params;
        const { token, jobId } = req.query;

        if (!token) {
            return res.status(401).send('Unauthorized: No token provided');
        }

        // Verify the token to ensure the user is valid before starting OAuth
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (e) {
            return res.status(401).send('Unauthorized: Invalid token');
        }

        // We use the JWT as the 'state' variable so it passes safely through the OAuth flow
        // We append jobId to the state to maintain context
        const state = jobId ? `${token}___${jobId}` : token;

        // Redirect URL logic
        const backendBaseUrl = process.env.BACKEND_URL || 'https://api.equipoexperto.com';
        const callbackUrl = `${backendBaseUrl}/api/integrations/${provider}/callback`;

        if (provider === 'google') {
            const clientId = process.env.GOOGLE_CLIENT_ID;
            if (clientId) {
                // Real Google OAuth Redirect with Business Profile + Gmail scopes
                const scopes = [
                    'email',
                    'profile',
                    'https://mail.google.com/',
                    'https://www.googleapis.com/auth/business.manage'
                ].join(' ');
                
                const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${callbackUrl}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent&state=${state}`;
                return res.redirect(authUrl);
            } else {
                // Mock OAuth Redirect
                return res.redirect(`/api/integrations/mock-oauth?provider=google&state=${state}&redirect_uri=${callbackUrl}`);
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

        // Extract token and jobId from state
        let actualToken = state;
        let jobId = '';
        if (state && typeof state === 'string' && state.includes('___')) {
            const parts = state.split('___');
            actualToken = parts[0];
            jobId = parts[1];
        }

        // Redirect to frontend fallback
        let frontendRedirect = `${process.env.FRONTEND_URL || 'https://www.equipoexperto.com'}/dashboard/employee`;
        if (jobId) {
            frontendRedirect += `/${jobId}`;
        }

        if (error) {
            console.error(`[${provider} OAuth Error]:`, error);
            return res.redirect(`${frontendRedirect}?error=oauth_failed`);
        }

        if (!code || !state) {
            return res.redirect(`${frontendRedirect}?error=invalid_callback`);
        }

        // Verify the state (which is the user's actualToken)
        let decoded;
        try {
            decoded = jwt.verify(actualToken, process.env.JWT_SECRET);
        } catch (e) {
            return res.redirect(`${frontendRedirect}?error=invalid_state`);
        }

        const userId = decoded.id;
        let accessToken = '';
        let refreshToken = '';
        let accountId = '';
        let expiresAt = null;

        const backendBaseUrl = process.env.BACKEND_URL || 'https://api.equipoexperto.com';
        const callbackUrl = `${backendBaseUrl}/api/integrations/${provider}/callback`;

        // 1. Exchange 'code' for tokens based on the provider
        if (provider === 'google' && process.env.GOOGLE_CLIENT_ID) {
            // Real Google Token Exchange
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: callbackUrl
                })
            });
            const tokenData = await tokenResponse.json();
            if (tokenData.error) throw new Error(tokenData.error_description);

            accessToken = tokenData.access_token;
            refreshToken = tokenData.refresh_token || null;
            
            // ATTEMPT TO FETCH GMB REVIEW URL
            try {
                // 1. Get Accounts
                const accountsRes = await fetch('https://mybusinessbusinessinformation.googleapis.com/v1/accounts', {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                const accountsData = await accountsRes.json();
                
                if (accountsData.accounts && accountsData.accounts.length > 0) {
                    const accountName = accountsData.accounts[0].name;
                    const locationsRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,metadata`, {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    });
                    const locationsData = await locationsRes.json();
                    
                    if (locationsData.locations && locationsData.locations.length > 0) {
                        const loc = locationsData.locations[0];
                        // Prioritize the review URL, fallback to mapsUri
                        accountId = loc.metadata?.newReviewUrl || loc.metadata?.mapsUri || 'Google Business Connected';
                    } else {
                        accountId = 'Google Account Connected';
                    }
                } else {
                    accountId = 'Google Account Connected';
                }
            } catch (gmbErr) {
                console.error('[GMB Fetch Error]:', gmbErr);
                accountId = 'Connected';
            }
            
            // If still no link, use 'Connected' so it shows as connected in UI
            if (!accountId || !accountId.startsWith('http')) {
                accountId = 'Connected';
            }

            if (tokenData.expires_in) {
                expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
            }

        } else if (provider === 'microsoft' && process.env.MICROSOFT_CLIENT_ID) {
            // Real Microsoft Token Exchange
            const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-form-urlencoded' },
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
            accountId = 'Microsoft Account Connected';

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
            `INSERT INTO integrations (user_id, provider, access_token, refresh_token, expires_at, account_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (user_id, provider) 
             DO UPDATE SET 
                access_token = EXCLUDED.access_token,
                refresh_token = COALESCE(EXCLUDED.refresh_token, integrations.refresh_token),
                expires_at = EXCLUDED.expires_at,
                account_id = EXCLUDED.account_id,
                updated_at = NOW()`,
            [userId, provider, accessToken, refreshToken, expiresAt, accountId]
        );

        // 3. Redirect user back to the dashboard integrations tab successfully
        return res.redirect(`${frontendRedirect}?success=connected`);

    } catch (err) {
        console.error('[providerCallback] CRITICAL ERROR:', err);
        // Extract jobId for fallback redirect
        let jobId = '';
        if (req.query.state && typeof req.query.state === 'string' && req.query.state.includes('___')) {
            jobId = req.query.state.split('___')[1];
        }
        let frontendRedirect = `${process.env.FRONTEND_URL || 'https://www.equipoexperto.com'}/dashboard/employee`;
        if (jobId) frontendRedirect += `/${jobId}`;
        
        // Pass the error message to the frontend for easier debugging
        return res.redirect(`${frontendRedirect}?error=server_error&details=${encodeURIComponent(err.message)}`);
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
