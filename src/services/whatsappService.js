import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import pool from '../db/pool.js';

// Store clients, their current QR codes, and status
const clients = new Map();
const clientQRs = new Map();
const clientStatus = new Map();

export const initWhatsAppClient = async (userId) => {
    if (clients.has(userId)) {
        return { success: true, message: 'Client already initializing or ready' };
    }

    clientStatus.set(userId, 'initializing');
    
    // Use LocalAuth to persist session across restarts
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `user_${userId}` }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu']
        }
    });

    client.on('qr', async (qr) => {
        try {
            clientStatus.set(userId, 'qr_ready');
            const qrDataUrl = await qrcode.toDataURL(qr);
            clientQRs.set(userId, qrDataUrl);
        } catch (err) {
            console.error('QR generation error', err);
        }
    });

    client.on('ready', async () => {
        console.log(`WhatsApp Client for user ${userId} is ready!`);
        clientStatus.set(userId, 'connected');
        clientQRs.delete(userId);
        
        // Ensure integration is recorded in the DB
        try {
            await pool.query(
                `INSERT INTO integrations (user_id, provider, account_id, updated_at) 
                 VALUES ($1, 'whatsapp', $2, NOW()) 
                 ON CONFLICT (user_id, provider) DO UPDATE SET updated_at = NOW()`,
                [userId, `wa_session_${userId}`]
            );
        } catch (e) {
            console.error('Error saving whatsapp status', e);
        }
    });

    client.on('disconnected', async (reason) => {
        console.log(`WhatsApp Client for user ${userId} disconnected:`, reason);
        clients.delete(userId);
        clientQRs.delete(userId);
        clientStatus.delete(userId);
        
        try {
            await pool.query('DELETE FROM integrations WHERE user_id = $1 AND provider = $2', [userId, 'whatsapp']);
        } catch (e) {
            console.error('Error removing whatsapp status', e);
        }
    });

    // Handle authentication failure
    client.on('auth_failure', () => {
        console.error(`WhatsApp auth failed for user ${userId}`);
        clientStatus.set(userId, 'auth_failed');
        clients.delete(userId);
    });

    client.initialize().catch(err => {
        console.error('Client init error', err);
        clients.delete(userId);
        clientStatus.set(userId, 'error');
    });

    clients.set(userId, client);
    return { success: true };
};

export const getSessionStatus = (userId) => {
    return {
        status: clientStatus.get(userId) || 'disconnected',
        qr: clientQRs.get(userId) || null
    };
};

export const getClient = (userId) => {
    return clients.get(userId);
};

export const disconnectClient = async (userId) => {
    const client = clients.get(userId);
    if (client) {
        try {
            await client.logout();
        } catch(e) {}
        try {
             await client.destroy();
        } catch(e) {}
        clients.delete(userId);
        clientQRs.delete(userId);
        clientStatus.delete(userId);
    }
};

export const restoreActiveSessions = async () => {
    try {
        const result = await pool.query("SELECT DISTINCT user_id FROM integrations WHERE provider = 'whatsapp'");
        for (const row of result.rows) {
            console.log(`Restoring WhatsApp session for user ${row.user_id}`);
            await initWhatsAppClient(row.user_id);
        }
    } catch (e) {
        console.error('Failed to restore whatsapp sessions', e);
    }
};
