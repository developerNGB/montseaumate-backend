import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const createDb = async () => {
    // Connect to the default 'postgres' database first to create our app's database
    const connectionString = process.env.DATABASE_URL.replace('/montseaumate', '/postgres');

    const client = new pg.Client({ connectionString });

    try {
        await client.connect();

        // Check if database exists
        const res = await client.query("SELECT 1 FROM pg_database WHERE datname = 'montseaumate'");
        if (res.rowCount === 0) {
            console.log('Database "montseaumate" does not exist. Creating it...');
            await client.query('CREATE DATABASE montseaumate');
            console.log('✅ Database "montseaumate" created.');
        } else {
            console.log('✅ Database "montseaumate" already exists.');
        }
    } catch (e) {
        console.error('Failed to ensure database exists:', e);
    } finally {
        await client.end();
    }
};

createDb();
