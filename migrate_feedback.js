import pool from './src/db/pool.js';

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('🚀 Starting migration for Feedback System...');

        // 1. Create Feedback Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS feedback (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                automation_id VARCHAR(50) NOT NULL,
                rating_service INTEGER NOT NULL DEFAULT 5,
                rating_product INTEGER NOT NULL DEFAULT 5,
                rating_overall INTEGER NOT NULL DEFAULT 5,
                comment TEXT,
                contact_requested BOOLEAN DEFAULT false,
                customer_name VARCHAR(255),
                customer_email VARCHAR(255),
                customer_phone VARCHAR(50),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('✅ Feedback table created.');

        // 2. Add n8n webhook field to review_funnel_settings if missing
        await client.query(`
            ALTER TABLE review_funnel_settings 
            ADD COLUMN IF NOT EXISTS n8n_webhook_url VARCHAR(255);
        `);
        console.log('✅ n8n_webhook_url column ensured in review_funnel_settings.');

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
