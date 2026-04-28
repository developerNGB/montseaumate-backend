import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import csrf from 'csurf';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/authRoutes.js';
import integrationRoutes from './routes/integrationRoutes.js';
import configRoutes from './routes/configRoutes.js';
import publicRoutes from './routes/publicRoutes.js';
import activityLogsRoutes from './routes/activityLogsRoutes.js';
import leadsRoutes from './routes/leadsRoutes.js';
import marketplaceRoutes from './routes/marketplaceRoutes.js';
import statsRoutes from './routes/statsRoutes.js';
import feedbackRoutes from './routes/feedbackRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import translationRoutes from './routes/translationRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import smtpRoutes from './routes/smtpRoutes.js';
import apolloRoutes from './routes/apolloRoutes.js';
import startFollowupCron from './cron/followupCron.js';
import startWeeklyReportCron from './cron/reportCron.js';
import { restoreActiveSessions } from './services/whatsappService.js';
import pool from './db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 5000;

// Warn on startup if critical env vars are missing
['JWT_SECRET', 'DATABASE_URL'].forEach(key => {
    if (!process.env[key]) console.error(`❌ Missing env var: ${key} — server will not function correctly`);
});

// ────────────────────────────────────────────────────────────
// MIDDLEWARE
// ────────────────────────────────────────────────────────────

// Trust Render's proxy for headers (needed for rate-limiting and reliable CORS)
app.set('trust proxy', 1);

// CORS Whitelist for production and local environments
const whitelist = [
    'https://www.equipoexperto.com',
    'https://equipoexperto.com',
    'https://montseaumateii.pages.dev',
    'https://www.montseaumate.com',
    'http://localhost:5173',
    'http://localhost:3000'
];

// Handle preflight OPTIONS requests BEFORE any other middleware
app.options('*', (req, res) => {
    const origin = req.headers.origin;
    if (!origin || whitelist.indexOf(origin) !== -1) {
        res.header('Access-Control-Allow-Origin', origin || '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Origin, Accept, X-Requested-With, X-CSRF-Token');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Max-Age', '86400'); // 24 hours
    }
    res.status(204).end();
});

// Enable COOP for Google login - must be set before CORS
app.use((req, res, next) => {
    // Allow popups for OAuth flows but maintain security
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    // Also needed for some OAuth scenarios
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
});

// CORS Middleware - Simplified and more reliable
app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        if (whitelist.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept', 'X-Requested-With', 'X-CSRF-Token'],
    optionsSuccessStatus: 204 // Proper status code for OPTIONS
}));

// Parse JSON bodies (limit to 10kb to prevent abuse)
app.use(express.json({ limit: '10kb' }));

// Remove fingerprinting header
app.disable('x-powered-by');

// ────────────────────────────────────────────────────────────
// RATE LIMITING
// ────────────────────────────────────────────────────────────

// General API rate limit - 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please try again later.' },
    skip: (req) => req.method === 'OPTIONS', // Skip preflight requests
});

// Stricter limit on auth endpoints: 5 attempts per 15 minutes
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Please wait 15 minutes.' },
});

app.use(generalLimiter);

// Cookie parser for CSRF and JWT cookies
app.use(cookieParser(process.env.COOKIE_SECRET || 'default-secret-change-in-production'));

// CSRF protection - skip for public webhooks
const csrfProtection = csrf({
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
});

// Skip CSRF for webhook/public routes and API routes that use JWT auth
app.use((req, res, next) => {
    const skipPaths = [
        '/api/public', '/api/webhooks', '/api/marketplace',
        '/api/integrations', '/api/whatsapp', '/api/config',
        '/api/apollo', '/api/apify',  // Apollo/Apify uses JWT auth, not CSRF
        '/api/f', '/api/r', '/api/l',  // Public feedback/review/lead endpoints
        '/auth/google', '/auth/microsoft', '/auth/account'
    ];
    if (skipPaths.some(path => req.path.startsWith(path))) {
        return next();
    }
    csrfProtection(req, res, next);
});

// CSRF token endpoint
app.get('/csrf-token', (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
});

// ────────────────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
    res.json({
        success: true,
        service: 'Equipo Experto API',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
    });
});

// Auth endpoints
app.use('/auth', authRoutes);

// Protected Dashboard Endpoints
app.use('/api/reports', reportRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/config', configRoutes);
app.use('/api/activity-logs', activityLogsRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/translations', translationRoutes);
app.use('/api/smtp', smtpRoutes);
app.use('/api/apollo', apolloRoutes);
app.use('/api/apify', apolloRoutes);  // Apify scrape routes (same controller)

// Public Facing Funnels (No Auth)
app.use('/api', publicRoutes);

// ────────────────────────────────────────────────────────────
// 404 handler
// ────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: `Route ${req.method} ${req.originalUrl} not found.`,
    });
});

// ────────────────────────────────────────────────────────────
// Global error handler
// ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[UnhandledError]', err);
    
    // Ensure CORS headers are attached on errors too
    const origin = req.headers.origin;
    if (whitelist.includes(origin) || !origin) {
        res.header('Access-Control-Allow-Origin', origin || '*');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Origin, Accept, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');

    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'An unexpected server error occurred.',
        debug: process.env.NODE_ENV === 'production' ? undefined : err.stack
    });
});

// ────────────────────────────────────────────────────────────
// Startup Migrations: Ensure schema and indices are optimized
// Run each migration independently — a single failure must never block the rest
const safeQuery = async (label, sql) => {
    try {
        await pool.query(sql);
    } catch (err) {
        console.error(`⚠️  Migration skipped [${label}]: ${err.message}`);
    }
};

const runMigrations = async () => {
    try {
        await safeQuery('users.phone',                  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)`);
        await safeQuery('users.weekly_reports_enabled', `ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_reports_enabled BOOLEAN DEFAULT TRUE`);
        await safeQuery('idx_leads_user_id',            `CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id)`);
        await safeQuery('idx_activity_logs_user_id',    `CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id)`);
        await safeQuery('idx_feedback_user_id',         `CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id)`);
        await safeQuery('idx_integrations_user_id',     `CREATE INDEX IF NOT EXISTS idx_integrations_user_id ON integrations(user_id)`);
        await safeQuery('translations_table',           `CREATE TABLE IF NOT EXISTS translations (id SERIAL PRIMARY KEY, key_name VARCHAR(255) UNIQUE NOT NULL, english_text TEXT, spanish_text TEXT, updated_at TIMESTAMP DEFAULT NOW())`);
        await safeQuery('review_funnel.lead_sources',    `ALTER TABLE review_funnel_settings ADD COLUMN IF NOT EXISTS lead_sources JSONB DEFAULT '["qr"]'`);
        await safeQuery('review_funnel.capture_sources', `ALTER TABLE review_funnel_settings ADD COLUMN IF NOT EXISTS capture_sources JSONB DEFAULT '["qr"]'`);
        
        // Create marketplace_leads table + contact info columns (Apify enrichment)
        await safeQuery('marketplace_leads_table', `
            CREATE TABLE IF NOT EXISTS marketplace_leads (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                external_id VARCHAR(255) NOT NULL,
                source VARCHAR(100) NOT NULL,
                category VARCHAR(50),
                title TEXT,
                price DECIMAL(15,2),
                currency VARCHAR(10) DEFAULT 'EUR',
                location VARCHAR(500),
                url TEXT,
                image_url TEXT,
                description TEXT,
                fetched_at TIMESTAMP DEFAULT NOW(),
                created_at TIMESTAMP DEFAULT NOW(),
                size DECIMAL(10,2),
                rooms INTEGER,
                floor VARCHAR(50),
                agency VARCHAR(255),
                brand VARCHAR(100),
                model VARCHAR(100),
                year INTEGER,
                mileage DECIMAL(10,2),
                fuel VARCHAR(50),
                company VARCHAR(255),
                salary VARCHAR(100),
                contract_type VARCHAR(50),
                is_remote BOOLEAN DEFAULT FALSE,
                raw_data JSONB,
                UNIQUE(user_id, external_id)
            )
        `);
        await safeQuery('idx_marketplace_leads_user_id',  `CREATE INDEX IF NOT EXISTS idx_marketplace_leads_user_id ON marketplace_leads(user_id)`);
        await safeQuery('idx_marketplace_leads_source',   `CREATE INDEX IF NOT EXISTS idx_marketplace_leads_source ON marketplace_leads(source)`);
        await safeQuery('idx_marketplace_leads_category', `CREATE INDEX IF NOT EXISTS idx_marketplace_leads_category ON marketplace_leads(category)`);
        await safeQuery('marketplace_leads.seller_name',  `ALTER TABLE marketplace_leads ADD COLUMN IF NOT EXISTS seller_name VARCHAR(255)`);
        await safeQuery('marketplace_leads.seller_phone', `ALTER TABLE marketplace_leads ADD COLUMN IF NOT EXISTS seller_phone VARCHAR(100)`);
        await safeQuery('marketplace_leads.seller_email', `ALTER TABLE marketplace_leads ADD COLUMN IF NOT EXISTS seller_email VARCHAR(255)`);
        await safeQuery('marketplace_leads.contact_url',  `ALTER TABLE marketplace_leads ADD COLUMN IF NOT EXISTS contact_url TEXT`);

        // leads table expansion
        await safeQuery('leads.followup_step_index', `ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_step_index INTEGER DEFAULT 0`);
        await safeQuery('leads.last_followup_at',    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ`);

        console.log('✅ Startup migrations & performance indices verified.');
        
        // Finalize Startup
        startServer();
    } catch (err) {
        console.error('❌ Startup migration failed:', err.message);
        // Start server anyway to allow debugging/logs
        startServer();
    }
};

const startServer = () => {
    app.listen(PORT, () => {
        console.log(`\n🚀 Equipo Experto API running on http://localhost:${PORT}`);
        console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
        console.log(`   CORS origin : ${process.env.FRONTEND_URL || 'http://localhost:5173'}\n`);

        // Start background background Cron Worker
        startFollowupCron();
        startWeeklyReportCron();
        
        // Restore WhatsApp Sessions
        restoreActiveSessions();
    });
};

runMigrations();
