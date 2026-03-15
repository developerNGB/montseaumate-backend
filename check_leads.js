import pool from './src/db/pool.js';
import dotenv from 'dotenv';
dotenv.config();

async function checkLeads() {
    try {
        const res = await pool.query("SELECT * FROM leads LIMIT 10");
        console.log('Leads found:', res.rowCount);
        console.log(JSON.stringify(res.rows, null, 2));
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

checkLeads();
