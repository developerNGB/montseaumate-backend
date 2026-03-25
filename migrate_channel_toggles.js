/**
 * Migration: Add channel toggles (whatsapp_enabled, email_enabled) to automation tables.
 */
import pool from './src/db/pool.js';

const migrate = async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding whatsapp_enabled, email_enabled to review_funnel_settings...');
        await client.query(`
            ALTER TABLE review_funnel_settings 
            ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN DEFAULT TRUE;
        `);

        console.log('Adding whatsapp_enabled, email_enabled to lead_followup_settings...');
        await client.query(`
            ALTER TABLE lead_followup_settings 
            ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN DEFAULT TRUE;
        `);

        await client.query('COMMIT');
        console.log('✅ Channel toggles migration successful.');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', err.message);
    } finally {
        client.release();
        process.exit(0);
    }
};

migrate();
