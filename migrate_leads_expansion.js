import pool from './src/db/pool.js';

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('🚀 Starting migration for Leads System Expansion...');

        // 1. Add new columns to leads table if missing
        await client.query(`
            ALTER TABLE leads 
            ADD COLUMN IF NOT EXISTS notes TEXT,
            ADD COLUMN IF NOT EXISTS lead_status VARCHAR(50) DEFAULT 'New',
            ALTER COLUMN source SET DEFAULT 'QR Survey';
        `);
        console.log('✅ Added notes and lead_status columns to leads table.');

        // 2. Standardize existing lead statuses if needed (optional)
        // For now just ensuring defaults are sane.

        await client.query('COMMIT');
        console.log('🎉 Migration successful!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', err.message);
    } finally {
        client.release();
        process.exit();
    }
}

migrate();
