import pool from './src/db/pool.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  try {
    const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'error_events'");
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
run();
