import dotenv from 'dotenv';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const r = await pool.query(
    `UPDATE error_events SET resolved = TRUE, resolved_at = NOW()
     WHERE resolved IS NOT TRUE
     RETURNING id`
);
console.log('Resolved', r.rowCount, 'open error_events');
await pool.end();
