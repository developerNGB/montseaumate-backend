import pool from './src/db/pool.js';

const run = async () => {
    try {
        await pool.query(`ALTER TABLE review_funnel_settings ADD COLUMN IF NOT EXISTS flow_json JSONB DEFAULT '{}'`);
        await pool.query(`ALTER TABLE lead_followup_settings ADD COLUMN IF NOT EXISTS flow_json JSONB DEFAULT '{}'`);
        console.log('Migration successful');
    } catch(err) {
        console.error(err);
    } finally {
        await pool.end();
    }
};

run();
