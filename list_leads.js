import pool from './src/db/pool.js';
import dotenv from 'dotenv';
dotenv.config();

const listLeads = async () => {
    try {
        const result = await pool.query('SELECT id, user_id, full_name, email, created_at FROM leads ORDER BY created_at DESC LIMIT 20');
        console.log('--- LATEST LEADS ---');
        console.log(JSON.stringify(result.rows, null, 2));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

listLeads();
