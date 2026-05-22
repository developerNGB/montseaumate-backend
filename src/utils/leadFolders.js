import pool from '../db/pool.js';
import { normalizeLeadGroup, DEFAULT_LEAD_GROUP } from './leadGroups.js';

export { normalizeLeadGroup, DEFAULT_LEAD_GROUP };

/** Ensure folder row exists when contacts are imported or captured. */
export async function upsertLeadFolder(userId, name, { followupMessage, sourceHint } = {}) {
    const folderName = normalizeLeadGroup(name, DEFAULT_LEAD_GROUP);
    await pool.query(
        `INSERT INTO lead_folders (user_id, name, followup_message, source_hint, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, name) DO UPDATE SET
            followup_message = COALESCE(EXCLUDED.followup_message, lead_folders.followup_message),
            source_hint = COALESCE(EXCLUDED.source_hint, lead_folders.source_hint),
            updated_at = NOW()`,
        [
            userId,
            folderName,
            followupMessage?.trim() || null,
            sourceHint?.trim() || null,
        ]
    );
    return folderName;
}

export async function getFolderMessage(userId, folderName) {
    const res = await pool.query(
        `SELECT followup_message FROM lead_folders WHERE user_id = $1 AND name = $2`,
        [userId, folderName]
    );
    return res.rows[0]?.followup_message?.trim() || null;
}
