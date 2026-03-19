import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
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
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'info' }), // Show connection info in logs
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
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                console.log(`[WA-Socket] Connection CLOSED for user ${userId}. Code: ${statusCode}`);
                console.error(`Detailed Error:`, lastDisconnect?.error);

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                clients.delete(userId);
                clientQRs.delete(userId);
                
                if (shouldReconnect) {
                    console.log(`[WA-Socket] Attempting RECONNECT for user ${userId}...`);
                    clientStatus.set(userId, 'restoring');
                    initWhatsAppClient(userId);
                } else {
                    console.log(`[WA-Socket] PERMANENT DISCONNECT (Logged Out) for user ${userId}`);
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
                console.log(`[WA-Socket] ✅ HANDSHAKE COMPLETE! Client for user ${userId} is ready!`);
                clientStatus.set(userId, 'connected');
                clientQRs.delete(userId);
                clients.set(userId, sock);
                
                try {
                    await pool.query(
                        `INSERT INTO integrations (user_id, provider, account_id, access_token, updated_at) 
                         VALUES ($1, 'whatsapp', $2, 'whatsapp_native_session', NOW()) 
                         ON CONFLICT (user_id, provider) DO UPDATE SET updated_at = NOW()`,
                        [userId, `wa_session_${userId}`]
                    );
                } catch (e) {
                    console.error('Error saving whatsapp status', e);
                }
            }
        });

        // Wait for connection event to handle storage
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
            console.log(`[WA-Restore] Starting background restoration for user ${row.user_id}`);
            initWhatsAppClient(row.user_id); // Run in background
        }
    } catch (e) {
        console.error('Failed to restore whatsapp sessions', e);
    }
};

export const sendWhatsAppMessage = async (userId, targetPhone, text) => {
    const status = clientStatus.get(userId);
    
    if (status === 'initializing' || status === 'restoring') {
        throw new Error("WhatsApp session is still connecting. Please wait 10-15 seconds and try again.");
    }

    const sock = clients.get(userId);
    if (!sock) {
        throw new Error("WhatsApp session not ready or disconnected. Please check status in dashboard.");
    }

    if (!sock.user) {
        throw new Error("WhatsApp session is active but user data is missing. Try reconnecting.");
    }

    try {
        // Strip non-digits and ensure format: 1234567890@s.whatsapp.net
        const cleaned = targetPhone.replace(/\D/g, '');
        const jid = `${cleaned}@s.whatsapp.net`;
        
        await sock.sendMessage(jid, { text });
        console.log(`Message successfully sent to ${jid} for user ${userId}`);
        return true;
    } catch (e) {
        console.error(`Failed to send message:`, e);
        throw e;
    }
};
