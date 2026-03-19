import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import pool from '../db/pool.js';
import fs from 'fs';

const clients = new Map();
const clientQRs = new Map();
const clientStatus = new Map();

export const initWhatsAppClient = async (userId) => {
    if (clients.has(userId)) {
        return { success: true, message: 'Client already initializing or ready' };
    }

    clientStatus.set(userId, 'initializing');
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(`wa_auth_${userId}`);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }), // Suppress detailed socket logs
            browser: ['Montseaumate', 'Chrome', '1.0.0']
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                clientStatus.set(userId, 'qr_ready');
                const qrDataUrl = await qrcode.toDataURL(qr);
                clientQRs.set(userId, qrDataUrl);
            }
            
            if (connection === 'close') {
                console.log(`WhatsApp Client for user ${userId} closed.`);
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                clients.delete(userId);
                clientQRs.delete(userId);
                
                if (shouldReconnect) {
                    clientStatus.set(userId, 'restoring');
                    initWhatsAppClient(userId);
                } else {
                    clientStatus.set(userId, 'disconnected');
                    try {
                        await pool.query('DELETE FROM integrations WHERE user_id = $1 AND provider = $2', [userId, 'whatsapp']);
                        if (fs.existsSync(`wa_auth_${userId}`)) {
                            fs.rmSync(`wa_auth_${userId}`, { recursive: true, force: true });
                        }
                    } catch (e) {
                        console.error('Error removing whatsapp status', e);
                    }
                }
            } else if (connection === 'open') {
                console.log(`WhatsApp Client for user ${userId} is ready!`);
                clientStatus.set(userId, 'connected');
                clientQRs.delete(userId);
                clients.set(userId, sock);
                
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
            }
        });

        // Store the instance initially to prevent multiple attempts
        clients.set(userId, sock);

    } catch (e) {
        console.error('Client init error', e);
        clientStatus.set(userId, 'error');
        clients.delete(userId);
    }
    
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
    const sock = clients.get(userId);
    if (sock) {
        try {
            await sock.logout();
        } catch(e) {}
        clients.delete(userId);
        clientQRs.delete(userId);
        clientStatus.delete(userId);
        if (fs.existsSync(`wa_auth_${userId}`)) {
            fs.rmSync(`wa_auth_${userId}`, { recursive: true, force: true });
        }
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
