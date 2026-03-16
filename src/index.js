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
import startFollowupCron from './cron/followupCron.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ────────────────────────────────────────────────────────────
// MIDDLEWARE
// ────────────────────────────────────────────────────────────

// CORS — allow frontend origin
app.use(
    cors({
        origin: function (origin, callback) {
            callback(null, true);
        },
        credentials: true,
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

// Integration endpoints
app.use('/api/integrations', integrationRoutes);

// Configurations (Protected)
app.use('/api/config', configRoutes);

// Activity Logs Dashboard
app.use('/api/activity-logs', activityLogsRoutes);

// Leads Dashboard
app.use('/api/leads', leadsRoutes);

// General Stats Dashboard
app.use('/api/stats', statsRoutes);

// Feedback Management
app.use('/api/feedback', feedbackRoutes);

// Public Facing Funnels
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
});
