import pool from '../db/pool.js';
import fetch from 'node-fetch';

/**
 * Returns a fresh { access_token, refresh_token } for a user's Google integration.
 * Refreshes the access token if it's expired or within 5 minutes of expiry.
 * If Google issues a new refresh token (token rotation), it is saved and returned.
 * @param {string} userId
 * @returns {Promise<{access_token: string|null, refresh_token: string|null}>}
 */
export const getValidGoogleTokens = async (userId) => {
    try {
        const result = await pool.query(
            'SELECT access_token, refresh_token, expires_at FROM integrations WHERE user_id = $1 AND provider = $2',
            [userId, 'google']
        );

        if (result.rows.length === 0) return { access_token: null, refresh_token: null };

        const { access_token, refresh_token, expires_at } = result.rows[0];

        const now = new Date();
        const buffer = 5 * 60 * 1000; // 5 minutes

        if (expires_at && new Date(expires_at).getTime() - now.getTime() > buffer) {
            return { access_token, refresh_token };
        }

        if (!refresh_token) {
            console.warn(`[GoogleAuth] No refresh token for user ${userId}, using stored access token`);
            return { access_token, refresh_token: null };
        }

        console.log(`[GoogleAuth] Refreshing token for user ${userId}...`);
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                refresh_token,
                grant_type: 'refresh_token'
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error(`[GoogleAuth] Refresh failed:`, data.error_description || data.error);
            // invalid_grant means the user revoked access or connected without Gmail scopes
            // They must reconnect their Google account from the Integrations page
            if (data.error === 'invalid_grant') {
                console.error(`[GoogleAuth] User ${userId} must reconnect Google account (scope or consent issue)`);
            }
            return { access_token, refresh_token };
        }

        const newAccessToken = data.access_token;
        const newRefreshToken = data.refresh_token || refresh_token; // Google may rotate refresh tokens
        const newExpiresAt = new Date(Date.now() + data.expires_in * 1000);

        await pool.query(
            'UPDATE integrations SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = NOW() WHERE user_id = $4 AND provider = $5',
            [newAccessToken, newRefreshToken, newExpiresAt, userId, 'google']
        );

        console.log(`[GoogleAuth] Token refreshed for user ${userId}${data.refresh_token ? ' (new refresh token issued)' : ''}`);
        return { access_token: newAccessToken, refresh_token: newRefreshToken };
    } catch (err) {
        console.error('[GoogleAuth] getValidGoogleTokens error:', err.message);
        return { access_token: null, refresh_token: null };
    }
};

// Legacy single-value export for backward compatibility
export const getValidGoogleToken = async (userId) => {
    const { access_token } = await getValidGoogleTokens(userId);
    return access_token;
};
