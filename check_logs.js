import pool from './src/db/pool.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  try {
    console.log('--- ERROR EVENTS ---');
    const errRes = await pool.query("SELECT * FROM error_events ORDER BY created_at DESC LIMIT 5");
    console.log(JSON.stringify(errRes.rows, null, 2));

    console.log('--- ACTIVITY LOGS ---');
    const actRes = await pool.query("SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 5");
    console.log(JSON.stringify(actRes.rows, null, 2));
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
run();
