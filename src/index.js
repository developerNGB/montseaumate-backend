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

// CORS configuration
const allowedOrigins = [
    'https://montseaumateii.pages.dev',
    'http://localhost:5173',
    process.env.FRONTEND_URL
].filter(Boolean);

app.use(
    cors({
        origin: function (origin, callback) {
            // Allow requests with no origin (e.g., mobile apps, curl)
            if (!origin) return callback(null, true);
            
            if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                console.warn(`[CORS] Unrecognized origin: ${origin}. Allowing for now but monitor.`);
                callback(null, true); // Still allowing to prevent lockouts during migration
            }
        },
        credentials: true,
        optionsSuccessStatus: 200, // Legacy support (IE, some proxies)
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept']
    })
);

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
    res.status(500).json({
        success: false,
        message: 'An unexpected server error occurred.',
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

    // Startup Migration: Ensure users table has the phone column
    pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)')
        .then(() => console.log('✅ Startup migration: phone column verified.'))
        .catch(err => console.error('❌ Startup migration failed:', err.message));
});
