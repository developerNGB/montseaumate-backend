import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load .env from monorepo root, server folder, or cwd (Render / local). */
export function loadProjectEnv() {
    const candidates = [
        path.join(__dirname, '../../../.env'),
        path.join(__dirname, '../../.env'),
        path.join(process.cwd(), '.env'),
        path.join(process.cwd(), '../.env'),
    ];

    for (const envPath of candidates) {
        if (fs.existsSync(envPath)) {
            dotenv.config({ path: envPath });
            return envPath;
        }
    }
    dotenv.config();
    return null;
}
