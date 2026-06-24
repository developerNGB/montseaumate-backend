import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import pool from '../db/pool.js';
import { useDBAuthState } from '../utils/dbAuthState.js';

const clients = new Map();
const clientQRs = new Map();
const clientStatus = new Map();

let cachedVersion;
export const initWhatsAppClient = async (userId) => {
    if (clients.has(userId)) {
        const status = clientStatus.get(userId);
        if (status !== 'error' && status !== 'disconnected') {
            console.log(`[WA-Init] Client already exists for user ${userId}, skipping.`);
            return { success: true, message: 'Client already initializing or ready' };
        }
        clients.delete(userId);
        clientQRs.delete(userId);
    }

    clientStatus.set(userId, 'initializing');
    console.log(`[WA-Init] Initializing WhatsApp client for user ${userId} (DB-backed session)...`);
    
    try {
        // Use DB-backed auth state — survives Render restarts
        const { state, saveCreds } = await useDBAuthState(userId);
        
        // Cache world-wide version to speed up multiple re-connections
        if (!cachedVersion) {
            try {
                const { version } = await fetchLatestBaileysVersion();
                cachedVersion = version;
            } catch (vErr) {
                cachedVersion = [2, 3000, 1015951307]; // Robust fallback
            }
        }
        const version = cachedVersion;

        console.log(`[WA-Init] Baileys version: ${version}. Creating socket...`);
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }), // Keep logs clean; we have our own logs
            browser: ['Equipo Experto', 'Chrome', '1.0.0']
        });
        clients.set(userId, sock);
        
        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
            } catch (err) {
                console.error(`[WA-Socket] Failed to persist credentials for user ${userId}:`, err.message);
                clientStatus.set(userId, 'error');
            }
        });
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                clientStatus.set(userId, 'qr_ready');
                console.log(`[WA-Socket] QR code generated for user ${userId}`);
                const qrDataUrl = await qrcode.toDataURL(qr);
                clientQRs.set(userId, qrDataUrl);
            }
            
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                console.log(`[WA-Socket] Connection CLOSED for user ${userId}. Code: ${statusCode}`);

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                clients.delete(userId);
                clientQRs.delete(userId);
                
                if (shouldReconnect) {
                    console.log(`[WA-Socket] Attempting RECONNECT for user ${userId}...`);
                    clientStatus.set(userId, 'restoring');
                    setTimeout(() => initWhatsAppClient(userId), 3000); // 3s delay before retry
                } else {
                    console.log(`[WA-Socket] PERMANENT DISCONNECT (Logged Out) for user ${userId}. Cleaning up DB.`);
                    clientStatus.set(userId, 'disconnected');
                    try {
                        await pool.query('DELETE FROM integrations WHERE user_id = $1 AND provider = $2', [userId, 'whatsapp']);
                        await pool.query('DELETE FROM whatsapp_sessions WHERE user_id = $1', [userId]);
                    } catch (e) {
                        console.error('[WA-Socket] Error cleaning up DB after logout:', e.message);
                    }
                }
            } else if (connection === 'open') {
                console.log(`[WA-Socket] ✅ CONNECTED! Session is live for user ${userId}`);
                clientStatus.set(userId, 'connected');
                clientQRs.delete(userId);
                
                const phoneNumber = (sock.user.id || '').split(':')[0].split('@')[0];
                console.log(`[WA-Socket] Phone number registered: ${phoneNumber}`);

                try {
                    await pool.query(
                        `INSERT INTO integrations (user_id, provider, account_id, access_token, updated_at) 
                         VALUES ($1, 'whatsapp', $2, 'whatsapp_native_session', NOW()) 
                         ON CONFLICT (user_id, provider) DO UPDATE SET 
                            account_id = EXCLUDED.account_id,
                            access_token = 'whatsapp_native_session',
                            updated_at = NOW()`,
                        [userId, phoneNumber]
                    );
                } catch (e) {
                    console.error('[WA-Socket] Error saving integration record:', e.message);
                }
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            try {
                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue;
                    const JID = msg.key.remoteJid;
                    if (!JID || !JID.endsWith('@s.whatsapp.net')) continue;
                    const fromPhone = JID.split('@')[0];
                    if (!fromPhone) continue;

                    // 1. Get message text
                    const messageType = Object.keys(msg.message || {})[0];
                    let text = '';
                    if (messageType === 'conversation') text = msg.message.conversation;
                    else if (messageType === 'extendedTextMessage') text = msg.message.extendedTextMessage.text;
                    
                    if (!text) continue; // Skip non-text messages for now

                    // 2. Upsert Inbox Conversation
                    const convResult = await pool.query(`
                        INSERT INTO inbox_conversations (user_id, contact_phone, contact_name, channel, last_message_text, last_message_time, is_read)
                        VALUES ($1, $2, $3, 'whatsapp', $4, NOW(), FALSE)
                        ON CONFLICT (id) DO UPDATE 
                        SET last_message_text = EXCLUDED.last_message_text, last_message_time = NOW(), is_read = FALSE
                        RETURNING id;
                    `, [userId, fromPhone, msg.pushName || fromPhone, text]);
                    // Wait, ON CONFLICT requires a unique constraint. We don't have a unique constraint on (user_id, contact_phone). 
                    // Let's do a SELECT first.
                    let convId;
                    const existingConv = await pool.query(
                        `SELECT id FROM inbox_conversations WHERE user_id = $1 AND contact_phone = $2 AND channel = 'whatsapp'`, 
                        [userId, fromPhone]
                    );
                    if (existingConv.rows.length > 0) {
                        convId = existingConv.rows[0].id;
                        await pool.query(
                            `UPDATE inbox_conversations SET last_message_text = $1, last_message_time = NOW(), is_read = FALSE, contact_name = COALESCE(NULLIF($2, ''), contact_name) WHERE id = $3`,
                            [text, msg.pushName || '', convId]
                        );
                    } else {
                        const newConv = await pool.query(`
                            INSERT INTO inbox_conversations (user_id, contact_phone, contact_name, channel, last_message_text, is_read)
                            VALUES ($1, $2, $3, 'whatsapp', $4, FALSE) RETURNING id
                        `, [userId, fromPhone, msg.pushName || fromPhone, text]);
                        convId = newConv.rows[0].id;
                    }

                    // 3. Insert Message
                    await pool.query(`
                        INSERT INTO inbox_messages (conversation_id, sender_type, text, is_read)
                        VALUES ($1, 'contact', $2, FALSE)
                    `, [convId, text]);

                    // 4. Update matching lead's status to 'Replied' if they are not already Replied
                    await pool.query(
                        `UPDATE leads SET lead_status = 'Replied', updated_at = NOW()
                         WHERE user_id = $1 AND regexp_replace(phone, '[^0-9]', '', 'g') = $2 AND lead_status != 'Replied'`,
                        [userId, fromPhone]
                    );
                }
            } catch (err) {
                console.error('[WA-Socket] Error updating inbox/lead on WhatsApp reply:', err.message);
            }
        });

    } catch (e) {
        console.error(`[WA-Init] Client init error for user ${userId}:`, e.message);
        clientStatus.set(userId, 'error');
        clients.delete(userId);
        throw e;
    }
    
    return { success: true };
};

export const getSessionStatus = (userId) => {
    const sock = clients.get(userId);
    return {
        status: clientStatus.get(userId) || 'disconnected',
        qr: clientQRs.get(userId) || null,
        phone: sock?.user?.id?.split(':')[0]?.split('@')[0] || null
    };
};

export const getClient = (userId) => {
    return clients.get(userId);
};

export const disconnectClient = async (userId) => {
    const sock = clients.get(userId);
    if (sock) {
        try { await sock.logout(); } catch(e) {}
        clients.delete(userId);
        clientQRs.delete(userId);
        clientStatus.delete(userId);
    }
    // Clean up DB session data
    try {
        await pool.query('DELETE FROM whatsapp_sessions WHERE user_id = $1', [userId]);
    } catch(e) {
        console.error('[WA-Disconnect] Error cleaning DB sessions:', e.message);
    }
};

export const restoreActiveSessions = async () => {
    try {
        const result = await pool.query("SELECT DISTINCT user_id FROM integrations WHERE provider = 'whatsapp' AND access_token = 'whatsapp_native_session'");
        console.log(`[WA-Restore] Found ${result.rows.length} session(s) to restore from DB...`);
        for (const row of result.rows) {
            console.log(`[WA-Restore] Restoring session for user ${row.user_id}`);
            initWhatsAppClient(row.user_id);
        }
    } catch (e) {
        console.error('[WA-Restore] Failed to restore sessions:', e.message);
    }
};

export const sendWhatsAppMessage = async (userId, targetPhone, text) => {
    const status = clientStatus.get(userId);
    console.log(`[WA-Send] Attempting to send to ${targetPhone} | userId=${userId} | status=${status}`);

    if (status === 'initializing' || status === 'restoring') {
        throw new Error(`WhatsApp session is still connecting (status: ${status}). Please wait and try again.`);
    }

    const sock = clients.get(userId);
    if (!sock) {
        throw new Error(`WhatsApp socket not found for user ${userId}. Status: ${status}. Please reconnect in dashboard.`);
    }

    if (!sock.user) {
        throw new Error("WhatsApp session active but user data missing. Try reconnecting.");
    }

    // Smart E.164 normalization:
    let cleaned = String(targetPhone).replace(/\D/g, ''); // strip all non-digits

    // 1. If it starts with 0 (local format), replace with owner's country code
    if (cleaned.startsWith('0') && cleaned.length >= 10 && cleaned.length <= 11) {
        const ownerNumber = (sock.user.id || '').split(':')[0].split('@')[0];
        const ccMatch = ownerNumber.match(/^(\d{1,3})/);
        const countryCode = ccMatch ? ccMatch[1] : '92'; 
        cleaned = countryCode + cleaned.slice(1);
        console.log(`[WA-Send] Normalized local 0-prefix: ${targetPhone} → ${cleaned}`);
    } 
    // 2. If it's a raw local number (e.g. 9 digits for Spain like 612345678, or 10 for PK/US)
    // and doesn't already have a country code that matches the owner's start
    else if (cleaned.length >= 9 && cleaned.length <= 10) {
        const ownerNumber = (sock.user.id || '').split(':')[0].split('@')[0];
        const ccMatch = ownerNumber.match(/^(\d{1,3})/);
        const countryCode = ccMatch ? ccMatch[1] : '92';
        
        // If it doesn't already start with the country code, prepend it
        if (!cleaned.startsWith(countryCode)) {
            cleaned = countryCode + cleaned;
            console.log(`[WA-Send] Prepended country code ${countryCode}: ${targetPhone} → ${cleaned}`);
        }
    }

    if (!cleaned || cleaned.length < 7) {
        throw new Error(`Invalid phone number: "${targetPhone}"`);
    }

    const jid = `${cleaned}@s.whatsapp.net`;
    console.log(`[WA-Send] Sending message to JID: ${jid}`);

    await sock.sendMessage(jid, { text });
    console.log(`[WA-Send] ✅ Message delivered to ${jid}`);

    // Log outbound message to inbox
    try {
        let convId;
        const existingConv = await pool.query(
            `SELECT id FROM inbox_conversations WHERE user_id = $1 AND contact_phone = $2 AND channel = 'whatsapp'`, 
            [userId, cleaned]
        );
        if (existingConv.rows.length > 0) {
            convId = existingConv.rows[0].id;
            await pool.query(
                `UPDATE inbox_conversations SET last_message_text = $1, last_message_time = NOW() WHERE id = $2`,
                [text, convId]
            );
        } else {
            const newConv = await pool.query(`
                INSERT INTO inbox_conversations (user_id, contact_phone, contact_name, channel, last_message_text, is_read)
                VALUES ($1, $2, $3, 'whatsapp', $4, TRUE) RETURNING id
            `, [userId, cleaned, cleaned, text]);
            convId = newConv.rows[0].id;
        }

        await pool.query(`
            INSERT INTO inbox_messages (conversation_id, sender_type, text, is_read)
            VALUES ($1, 'business', $2, TRUE)
        `, [convId, text]);
    } catch (dbErr) {
        console.error('[WA-Send] Error logging outbound message to inbox:', dbErr.message);
    }

    return true;
};

