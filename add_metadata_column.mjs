import pool from './src/db/pool.js';

const run = async () => {
    try {
        // Check existing columns
        const cols = await pool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'integrations' ORDER BY ordinal_position`
        );
        console.log('Existing columns:', cols.rows.map(r => r.column_name).join(', '));

        // Add metadata column if missing
        await pool.query(`
            ALTER TABLE integrations
            ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb
        `);
        console.log('✅ metadata column added (or already existed).');

        // Also ensure expires_at exists (used in the same INSERT)
        await pool.query(`
            ALTER TABLE integrations
            ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
        `);
        console.log('✅ expires_at column checked/added.');

        // Verify final schema
        const final = await pool.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'integrations' ORDER BY ordinal_position`
        );
        console.log('\nFinal integrations schema:');
        final.rows.forEach(r => console.log(`  - ${r.column_name}: ${r.data_type}`));

    } catch (err) {
        console.error('❌ Migration failed:', err.message);
    } finally {
        await pool.end();
    }
};

run();
