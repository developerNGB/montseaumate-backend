import pool from './pool.js';

/**
 * Initialize database tables.
 * Run with: npm run db:init
 */
const initDB = async () => {
    const client = await pool.connect();

    try {
        console.log('🔧 Initializing database tables...\n');

        await client.query('BEGIN');

        // ──────────────────────────────────────────────
        // USERS TABLE
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name            VARCHAR(255) NOT NULL,
                email           VARCHAR(255) UNIQUE NOT NULL,
                password_hash   VARCHAR(255) NOT NULL,
                company_name    VARCHAR(255),
                phone           VARCHAR(50),
                plan            VARCHAR(50) DEFAULT 'free',
                role            VARCHAR(50) DEFAULT 'owner',
                status          VARCHAR(50) DEFAULT 'active',
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                updated_at      TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('  ✅ users table ready');

        await client.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
        `);
        console.log('  ✅ users phone column ensured');

        // ──────────────────────────────────────────────
        // INDEX on email for fast lookups
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
        `);
        console.log('  ✅ users email index ready');

        // ──────────────────────────────────────────────
        // PASSWORD RESETS TABLE
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS password_resets (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash VARCHAR(255) NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('  ✅ password_resets table ready');

        // ──────────────────────────────────────────────
        // PASSWORD HISTORY TABLE (prevents reusing old passwords)
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS password_history (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('  ✅ password_history table ready');

        // ──────────────────────────────────────────────
        // INTEGRATIONS TABLE
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS integrations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                provider VARCHAR(50) NOT NULL,
                access_token TEXT NOT NULL,
                refresh_token TEXT,
                expires_at TIMESTAMPTZ,
                account_id VARCHAR(255),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (user_id, provider)
            );
        `);
        // Migration: Add expires_at if it's missing from previous versions
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='integrations' AND column_name='expires_at') THEN
                    ALTER TABLE integrations ADD COLUMN expires_at TIMESTAMPTZ;
                END IF;
            END $$;
        `);
        console.log('  ✅ integrations table ready');

        // ──────────────────────────────────────────────
        // REVIEW FUNNEL SETTINGS TABLE
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS review_funnel_settings (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                automation_id VARCHAR(50) UNIQUE NOT NULL,
                google_review_url VARCHAR(255) NOT NULL,
                notification_email VARCHAR(255) NOT NULL,
                auto_response_message TEXT,
                is_active BOOLEAN DEFAULT false,
                lead_capture_active BOOLEAN DEFAULT false,
                filtering_questions JSONB DEFAULT '[]',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query("ALTER TABLE review_funnel_settings ADD COLUMN IF NOT EXISTS filtering_questions JSONB DEFAULT '[]'");
        await client.query("ALTER TABLE review_funnel_settings ADD COLUMN IF NOT EXISTS auto_response_message TEXT");
        console.log('  ✅ review_funnel_settings table ready');

        // ──────────────────────────────────────────────
        // ACTIVITY LOGS TABLE
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                automation_name VARCHAR(100) NOT NULL,
                trigger_type VARCHAR(50),
                status VARCHAR(20),
                detail VARCHAR(255),
                metadata JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('  ✅ activity_logs table ready');

        // ──────────────────────────────────────────────
        // LEADS TABLE
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                full_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                message TEXT,
                source VARCHAR(100) DEFAULT 'Direct Source',
                followup_status VARCHAR(50) DEFAULT 'pending',
                followup_status_reminder VARCHAR(50) DEFAULT 'pending',
                consent_given BOOLEAN DEFAULT false,
                marketing_consent BOOLEAN DEFAULT false,
                filtering_responses JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        // Migration: Add columns if missing
        await client.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_given BOOLEAN DEFAULT false");
        await client.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN DEFAULT false");
        await client.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_status_reminder VARCHAR(50) DEFAULT 'pending'");
        await client.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS filtering_responses JSONB DEFAULT '{}'");
        await client.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()");
        console.log('  ✅ leads table ready');

        // ──────────────────────────────────────────────
        // LEAD FOLLOWUP SETTINGS
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS lead_followup_settings (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                is_active BOOLEAN DEFAULT false,
                delay_value INTEGER DEFAULT 24,
                delay_unit VARCHAR(20) DEFAULT 'hours',
                message TEXT,
                reminder_active BOOLEAN DEFAULT false,
                reminder_delay_value INTEGER DEFAULT 48,
                reminder_delay_unit VARCHAR(20) DEFAULT 'hours',
                reminder_message TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query(`
            ALTER TABLE lead_followup_settings ADD COLUMN IF NOT EXISTS reminder_active BOOLEAN DEFAULT false;
            ALTER TABLE lead_followup_settings ADD COLUMN IF NOT EXISTS reminder_delay_value INTEGER DEFAULT 48;
            ALTER TABLE lead_followup_settings ADD COLUMN IF NOT EXISTS reminder_delay_unit VARCHAR(20) DEFAULT 'hours';
            ALTER TABLE lead_followup_settings ADD COLUMN IF NOT EXISTS reminder_message TEXT;
        `);
        console.log('  ✅ lead_followup_settings table ready');

        // ──────────────────────────────────────────────
        // PASSWORD RESETS TABLE
        // ──────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS password_resets (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                used BOOLEAN DEFAULT false
            );
        `);
        console.log('  ✅ password_resets table ready');

        // Alterations in case table already exists
        try {
            await client.query("ALTER TABLE lead_followup_settings RENAME COLUMN delay_hours TO delay_value");
        } catch (e) { }
        try {
            await client.query("ALTER TABLE lead_followup_settings ADD COLUMN IF NOT EXISTS delay_unit VARCHAR(20) DEFAULT 'hours'");
        } catch (e) { }

        await client.query('COMMIT');
        console.log('\n🎉 Database initialization complete!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Database initialization failed:', err);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
};

initDB().catch((err) => {
    console.error('Unhandled initialization error:', err);
    process.exit(1);
});
