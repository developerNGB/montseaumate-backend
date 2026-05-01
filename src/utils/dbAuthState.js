import pool from '../db/pool.js';
import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

/**
 * Stores Baileys WhatsApp auth credentials in PostgreSQL.
 * This replaces useMultiFileAuthState so sessions survive server restarts on Render.
 */
export const useDBAuthState = async (userId) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (user_id, key)
        )
    `);

    const readData = async (key) => {
        try {
            const result = await pool.query(
                `SELECT value FROM whatsapp_sessions WHERE user_id = $1 AND key = $2`,
                [userId, key]
            );
            if (result.rows.length === 0) return null;
            return JSON.parse(result.rows[0].value, BufferJSON.reviver);
        } catch (e) {
            console.error(`[DBAuthState] Read error for key "${key}":`, e.message);
            throw e;
        }
    };

    const writeData = async (key, value) => {
        try {
            const serialized = JSON.stringify(value, BufferJSON.replacer);
            await pool.query(
                `INSERT INTO whatsapp_sessions (user_id, key, value, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [userId, key, serialized]
            );
        } catch (e) {
            console.error(`[DBAuthState] Write error for key "${key}":`, e.message);
            throw e;
        }
    };

    const removeData = async (key) => {
        try {
            await pool.query(
                `DELETE FROM whatsapp_sessions WHERE user_id = $1 AND key = $2`,
                [userId, key]
            );
        } catch (e) {
            console.error(`[DBAuthState] Delete error for key "${key}":`, e.message);
            throw e;
        }
    };

    // Load credentials from DB or generate fresh ones
    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const val = await readData(`${type}-${id}`);
                        if (val) {
                            data[id] = type === 'app-state-sync-key'
                                ? proto.Message.AppStateSyncKeyData.fromObject(val)
                                : val;
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    for (const [category, categoryData] of Object.entries(data)) {
                        for (const [id, value] of Object.entries(categoryData || {})) {
                            const key = `${category}-${id}`;
                            if (value) {
                                await writeData(key, value);
                            } else {
                                await removeData(key);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        }
    };
};
