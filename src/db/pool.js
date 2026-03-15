import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
});

// Test connection on import
pool.on('connect', () => {
    console.log('✅ Connected to PostgreSQL');
});

pool.on('error', (err) => {
    console.error('❌ PostgreSQL pool error:', err.message);
});

export default pool;
