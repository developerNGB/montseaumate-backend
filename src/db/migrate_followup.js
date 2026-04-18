import pool from './pool.js';

const migrate = async () => {
    const client = await pool.connect();
    try {
        console.log('🚀 Starting Follow-up Automation Migration...');
        await client.query('BEGIN');

        // 1. Update lead_followup_settings table
        console.log('  - Updating lead_followup_settings table...');
        await client.query(`
            ALTER TABLE lead_followup_settings 
            ADD COLUMN IF NOT EXISTS followup_sequence JSONB DEFAULT '[]'
        `);

        // 2. Update leads table
        console.log('  - Updating leads table...');
        await client.query(`
            ALTER TABLE leads 
            ADD COLUMN IF NOT EXISTS followup_step_index INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ
        `);

        // 3. Optional: Fix marketing_consent for existing "New" leads as per user request
        // "every lead in db with status new should be checked and use to followup"
        console.log('  - Enabling marketing_consent for all "New" status leads...');
        await client.query(`
            UPDATE leads 
            SET marketing_consent = true 
            WHERE lead_status = 'New'
        `);

        await client.query('COMMIT');
        console.log('✅ Migration completed successfully!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', err.message);
    } finally {
        client.release();
        process.exit();
    }
};

migrate();
