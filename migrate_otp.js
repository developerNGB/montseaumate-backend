import pool from './src/db/pool.js';

async function runMigration() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Create OTP table
        await client.query(`
            CREATE TABLE IF NOT EXISTS otp_verifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email VARCHAR(255) NOT NULL,
                otp_code VARCHAR(6) NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await client.query('COMMIT');
        console.log('OTP table migration successful');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', err);
    } finally {
        client.release();
        process.exit();
    }
}

runMigration();
