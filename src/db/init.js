import pool from './pool.js';

/**
 * Initialize database tables.
 * Run with: npm run db:init
 */
const initDB = async () => {
    const client = await pool.connect();

    try {
        console.log('🔧 Initializing database tables (Consolidated Schema)...\n');

        await client.query('BEGIN');

        // 1. USERS TABLE
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
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)`);
        console.log('  ✅ users table ready');

        // 2. OTP VERIFICATIONS
        await client.query(`
            CREATE TABLE IF NOT EXISTS otp_verifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email VARCHAR(255) NOT NULL,
                otp_code VARCHAR(6) NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('  ✅ otp_verifications table ready');

        // 3. INTEGRATIONS
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
        await client.query(`ALTER TABLE integrations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
        console.log('  ✅ integrations table ready');

        // 4. REVIEW FUNNEL SETTINGS
        await client.query(`
            CREATE TABLE IF NOT EXISTS review_funnel_settings (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                automation_id VARCHAR(50) UNIQUE NOT NULL,
                google_review_url VARCHAR(255) NOT NULL,
                notification_email VARCHAR(255) NOT NULL,
                n8n_webhook_url VARCHAR(255),
                auto_response_message TEXT,
                is_active BOOLEAN DEFAULT false,
                lead_capture_active BOOLEAN DEFAULT false,
                filtering_questions JSONB DEFAULT '[]',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query(`ALTER TABLE review_funnel_settings ADD COLUMN IF NOT EXISTS n8n_webhook_url VARCHAR(255)`);
        await client.query(`ALTER TABLE review_funnel_settings ADD COLUMN IF NOT EXISTS auto_response_message TEXT`);
        await client.query(`ALTER TABLE review_funnel_settings ADD COLUMN IF NOT EXISTS filtering_questions JSONB DEFAULT '[]'`);
        await client.query(`ALTER TABLE review_funnel_settings ADD COLUMN IF NOT EXISTS whatsapp_number_fallback VARCHAR(50)`);
        console.log('  ✅ review_funnel_settings table ready');

        // 5. FEEDBACK TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS feedback (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                automation_id VARCHAR(50) NOT NULL,
                rating_service INTEGER NOT NULL DEFAULT 5,
                rating_product INTEGER NOT NULL DEFAULT 5,
                rating_overall INTEGER NOT NULL DEFAULT 5,
                comment TEXT,
                contact_requested BOOLEAN DEFAULT false,
                customer_name VARCHAR(255),
                customer_email VARCHAR(255),
                customer_phone VARCHAR(50),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('  ✅ feedback table ready');

        // 6. LEADS TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                full_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                message TEXT,
                notes TEXT,
                source VARCHAR(100) DEFAULT 'QR Survey',
                lead_status VARCHAR(50) DEFAULT 'New',
                followup_status VARCHAR(50) DEFAULT 'pending',
                followup_status_reminder VARCHAR(50) DEFAULT 'pending',
                consent_given BOOLEAN DEFAULT false,
                marketing_consent BOOLEAN DEFAULT false,
                filtering_responses JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        // Expansion Migrations
        await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT`);
        await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_status VARCHAR(50) DEFAULT 'New'`);
        await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_status_reminder VARCHAR(50) DEFAULT 'pending'`);
        await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN DEFAULT false`);
        await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_given BOOLEAN DEFAULT false`);
        await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS filtering_responses JSONB DEFAULT '{}'`);
        console.log('  ✅ leads table ready');

        // 7. LEAD FOLLOWUP SETTINGS
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
        await client.query(`ALTER TABLE lead_followup_settings ADD COLUMN IF NOT EXISTS reminder_active BOOLEAN DEFAULT false`);
        console.log('  ✅ lead_followup_settings table ready');

        // 8. SMTP SETTINGS (Custom Domain Email)
        await client.query(`
            CREATE TABLE IF NOT EXISTS smtp_settings (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                host VARCHAR(255) NOT NULL,
                port INTEGER NOT NULL DEFAULT 587,
                secure BOOLEAN DEFAULT false,
                auth_user VARCHAR(255) NOT NULL,
                auth_pass TEXT NOT NULL,
                from_email VARCHAR(255) NOT NULL,
                from_name VARCHAR(255),
                is_active BOOLEAN DEFAULT false,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('  ✅ smtp_settings table ready');

        // 9. HELPERS (Resets, Logs, History)
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
        await client.query(`
            CREATE TABLE IF NOT EXISTS password_history (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('  ✅ helper tables ready');

        await client.query('COMMIT');
        console.log('\n🎉 Database consolidated initialization complete!');
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
