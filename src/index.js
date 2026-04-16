import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/authRoutes.js';
import integrationRoutes from './routes/integrationRoutes.js';
import configRoutes from './routes/configRoutes.js';
import publicRoutes from './routes/publicRoutes.js';
import activityLogsRoutes from './routes/activityLogsRoutes.js';
import leadsRoutes from './routes/leadsRoutes.js';
import statsRoutes from './routes/statsRoutes.js';
import feedbackRoutes from './routes/feedbackRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import translationRoutes from './routes/translationRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import smtpRoutes from './routes/smtpRoutes.js';
import startFollowupCron from './cron/followupCron.js';
import startWeeklyReportCron from './cron/reportCron.js';
import { restoreActiveSessions } from './services/whatsappService.js';
import pool from './db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 5000;

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
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Origin, Accept, X-Requested-With');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Max-Age', '86400'); // 24 hours
    }
    res.status(204).end();
});

// Enable COOP for Google login
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
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
    allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept', 'X-Requested-With'],
    optionsSuccessStatus: 204 // Proper status code for OPTIONS
}));

// Parse JSON bodies (limit to 10kb to prevent abuse)
app.use(express.json({ limit: '10kb' }));

// Remove fingerprinting header and set COOP for Google Auth
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
});

// ────────────────────────────────────────────────────────────
// RATE LIMITING
// ────────────────────────────────────────────────────────────

// General API rate limit (Practically removed limit as requested)
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 999999, // Allow almost unlimited requests
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please try again later.' },
});

// Stricter limit on auth endpoints: 10 attempts per 15 minutes
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Please wait 15 minutes.' },
});

app.use(generalLimiter);

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
app.use('/api/stats', statsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/translations', translationRoutes);
app.use('/api/smtp', smtpRoutes);

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
const runMigrations = async () => {
    try {
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_reports_enabled BOOLEAN DEFAULT TRUE');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_integrations_user_id ON integrations(user_id)');
        await pool.query('CREATE TABLE IF NOT EXISTS translations (id SERIAL PRIMARY KEY, key_name VARCHAR(255) UNIQUE NOT NULL, english_text TEXT, spanish_text TEXT, updated_at TIMESTAMP DEFAULT NOW())');
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
