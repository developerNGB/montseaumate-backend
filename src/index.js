import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/authRoutes.js';
import integrationRoutes from './routes/integrationRoutes.js';
import configRoutes from './routes/configRoutes.js';
import publicRoutes from './routes/publicRoutes.js';
import activityLogsRoutes from './routes/activityLogsRoutes.js';
import leadsRoutes from './routes/leadsRoutes.js';
import statsRoutes from './routes/statsRoutes.js';
import feedbackRoutes from './routes/feedbackRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import startFollowupCron from './cron/followupCron.js';
import { restoreActiveSessions } from './services/whatsappService.js';
import pool from './db/pool.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ────────────────────────────────────────────────────────────
// MIDDLEWARE
// ────────────────────────────────────────────────────────────

// Trust Render's proxy for headers (needed for rate-limiting and reliable CORS)
app.set('trust proxy', 1);

// CORS Whitelist for production and local environments
const whitelist = [
    'https://montseaumateii.pages.dev',
    'https://www.montseaumate.com',
    'http://localhost:5173',
    'http://localhost:3000'
];

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
    optionsSuccessStatus: 200 // Some legacy browsers choke on 204
}));

// Additional CORS headers for preflight
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Credentials', 'true');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Parse JSON bodies (limit to 10kb to prevent abuse)
app.use(express.json({ limit: '10kb' }));

// Remove fingerprinting header
app.disable('x-powered-by');

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
        service: 'Montseaumate API',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
    });
});

// Auth endpoints
app.use('/auth', authRoutes);

// Public Facing Funnels (No Auth)
app.use('/api', publicRoutes);

// Protected Dashboard Endpoints
app.use('/api/integrations', integrationRoutes);
app.use('/api/config', configRoutes);
app.use('/api/activity-logs', activityLogsRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/whatsapp', whatsappRoutes);

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
// START
// ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Montseaumate API running on http://localhost:${PORT}`);
    console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
    console.log(`   CORS origin : ${process.env.FRONTEND_URL || 'http://localhost:5173'}\n`);

    // Start background background Cron Worker
    startFollowupCron();
    
    // Restore WhatsApp Sessions
    restoreActiveSessions();

    // Startup Migrations: Ensure schema and indices are optimized
    const runMigrations = async () => {
        try {
            await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_integrations_user_id ON integrations(user_id)');
            console.log('✅ Startup migrations & performance indices verified.');
        } catch (err) {
            console.error('❌ Startup migration failed:', err.message);
        }
    };
    runMigrations();
});
