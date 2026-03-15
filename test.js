import pg from 'pg';
const pool = new pg.Pool({connectionString: 'postgresql://postgres:postgres123%40%23%21@localhost:5432/montseaumate'});
pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'lead_followup_settings'").then(res => console.log(res.rows)).catch(console.error).finally(()=>process.exit(0));
