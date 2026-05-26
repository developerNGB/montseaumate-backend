import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import pool from '../src/db/pool.js';
import {
    listContactFormSenderUserIds,
    isContactFormMailConfigured,
    sendContactFormNotification,
} from '../src/services/contactFormMailService.js';

const ids = await listContactFormSenderUserIds();
console.log('sender user ids:', ids);
console.log('configured:', await isContactFormMailConfigured());

const rows = await pool.query(
    `SELECT user_id, account_id, metadata->>'email' AS email,
            (refresh_token IS NOT NULL) AS has_refresh
     FROM integrations WHERE provider = 'google'
     ORDER BY updated_at DESC LIMIT 10`,
);
console.log('google integrations:', rows.rows);

try {
    const r = await sendContactFormNotification({
        name: 'API Test',
        email: 'test@example.com',
        message: 'contact form smoke test',
        source: 'test',
    });
    console.log('SEND OK:', r);
} catch (e) {
    console.log('SEND FAIL:', e.code, e.message);
}

await pool.end();
