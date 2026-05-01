import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const normalizeDatabaseUrl = (connectionString) => {
    if (!connectionString) return connectionString;

    try {
        const url = new URL(connectionString);
        // pg-connection-string treats sslmode=require as verify-full in this version.
        // Keep SSL enabled below, but let rejectUnauthorized:false handle managed DB cert chains.
        url.searchParams.delete('sslmode');
        return url.toString();
    } catch {
        return connectionString;
    }
};

const pool = new pg.Pool({
    connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
    ssl: { rejectUnauthorized: false },
    max: 20, // Keep more connections ready
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// Test connection on import
pool.on('connect', () => {
    console.log('✅ Connected to PostgreSQL');
});

pool.on('error', (err) => {
    console.error('❌ PostgreSQL pool error:', err.message);
});

export default pool;
