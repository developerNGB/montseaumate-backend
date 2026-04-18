import pool from '../db/pool.js';
import fetch from 'node-fetch';

/**
 * Ensures a user's Microsoft access token is valid.
 * If it's expired or about to expire (within 5 mins), it uses the refresh token to get a new one.
 * @param {string} userId - The unique ID of the user
 * @returns {Promise<string|null>} - The valid access token or null if failed
 */
export const getValidMicrosoftToken = async (userId) => {
    try {
        const result = await pool.query(
            'SELECT access_token, refresh_token, expires_at FROM integrations WHERE user_id = $1 AND provider = $2',
            [userId, 'microsoft']
        );

        if (result.rows.length === 0) return null;

        const { access_token, refresh_token, expires_at } = result.rows[0];

        // Check if token is still valid (with 5 min buffer)
        const now = new Date();
        const buffer = 5 * 60 * 1000; // 5 minutes

        if (expires_at && new Date(expires_at).getTime() - now.getTime() > buffer) {
            return access_token;
        }

        // If no refresh token, we can't do anything
        if (!refresh_token) {
            console.warn(`[MicrosoftAuth] No refresh token available for user ${userId}`);
            return access_token; 
        }

        // Refresh the token
        console.log(`[MicrosoftAuth] Refreshing token for user ${userId}...`);
        const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.MICROSOFT_CLIENT_ID,
                client_secret: process.env.MICROSOFT_CLIENT_SECRET,
                refresh_token: refresh_token,
                grant_type: 'refresh_token',
                scope: 'offline_access user.read mail.send mail.readwrite'
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error(`[MicrosoftAuth] Refresh failed:`, data.error_description || data.error);
            return access_token;
        }

        const newAccessToken = data.access_token;
        const newExpiresAt = new Date(Date.now() + data.expires_in * 1000);

        // Update database with new token
        await pool.query(
            'UPDATE integrations SET access_token = $1, expires_at = $2, updated_at = NOW() WHERE user_id = $3 AND provider = $4',
            [newAccessToken, newExpiresAt, userId, 'microsoft']
        );

        return newAccessToken;
    } catch (err) {
        console.error('[MicrosoftAuth] getValidMicrosoftToken error:', err.message);
        return null;
    }
};
