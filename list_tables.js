import pool from './src/db/pool.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  try {
    const res = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    console.log(res.rows.map(r => r.table_name));
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
run();
