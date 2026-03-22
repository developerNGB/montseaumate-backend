/**
 * Migration: Create whatsapp_sessions table for persistent Baileys auth state.
 * Run with: node migrate_wa_sessions.js
 */
import pool from './src/db/pool.js';

const migrate = async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_sessions (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                key         VARCHAR(255) NOT NULL,
                value       TEXT NOT NULL,
                updated_at  TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (user_id, key)
            );
        `);

        await client.query(`CREATE INDEX IF NOT EXISTS idx_wa_sessions_user ON whatsapp_sessions (user_id)`);

        await client.query('COMMIT');
        console.log('✅ whatsapp_sessions table created successfully.');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', err.message);
    } finally {
        client.release();
        process.exit(0);
    }
};

migrate();
