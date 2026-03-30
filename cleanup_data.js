import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const cleanupData = async () => {
    try {
        console.log('🧹 Cleaning test data...');
        const result = await pool.query("DELETE FROM leads WHERE full_name ILIKE '%Jawad Arshad%'");
        console.log(`✅ Deleted ${result.rowCount} test leads.`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Cleanup failed:', err.message);
        process.exit(1);
    }
};

cleanupData();



