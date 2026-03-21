import pool from './src/db/pool.js';
import dotenv from 'dotenv';
dotenv.config();

const checkDB = async () => {
    try {
        const result = await pool.query('SELECT user_id, automation_id, filtering_questions, lead_capture_active FROM review_funnel_settings LIMIT 5');
        console.log('--- DATABASE CHECK ---');
        console.log(JSON.stringify(result.rows, null, 2));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

checkDB();
