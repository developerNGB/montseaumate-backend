import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import pool from './src/db/pool.js';

async function migrate() {
    try {
        console.log('--- MIGRATING: ADDING LEAD_SOURCE TO CONFIG TABLES ---');
        
        // Add to review_funnel_settings
        await pool.query(`
            ALTER TABLE review_funnel_settings 
            ADD COLUMN IF NOT EXISTS lead_source VARCHAR(50) DEFAULT 'qr'
        `);
        console.log('Added lead_source to review_funnel_settings');

        // Add to lead_followup_settings
        await pool.query(`
            ALTER TABLE lead_followup_settings 
            ADD COLUMN IF NOT EXISTS lead_source VARCHAR(50) DEFAULT 'excel'
        `);
        console.log('Added lead_source to lead_followup_settings');

        console.log('--- MIGRATION COMPLETE ---');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
