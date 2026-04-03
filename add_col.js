import pool from './src/db/pool.js';
async function update() {
  try {
    console.log('Adding followup_sequence column...');
    await pool.query("ALTER TABLE lead_followup_settings ADD COLUMN IF NOT EXISTS followup_sequence JSONB DEFAULT '[]'");
    console.log('Success!');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
update();
