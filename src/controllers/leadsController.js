import pool from '../db/pool.js';
import { sanitizeLeadRow, sanitizeLeads } from '../utils/leadPrivacy.js';
import { normalizeLeadGroup, DEFAULT_LEAD_GROUP } from '../utils/leadGroups.js';
import { upsertLeadFolder, getFolderMessage } from '../utils/leadFolders.js';
import { dispatchFollowupForLead } from '../services/leadDispatchService.js';
import { executeBulkLeadMessaging } from '../services/bulkLeadMessaging.js';
import { frontendBaseUrl } from '../utils/publicUrls.js';

/** Re-export for activity-log retry and internal tooling */
export { dispatchFollowupForLead };

const extractNameFromEmail = (email) => {
    if (!email) return null;
    const localPart = email.split('@')[0];
    const parts = localPart.replace(/[0-9]/g, '').split(/[._\-]/).filter((p) => p.length > 1);
    if (parts.length === 0) return null;
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
};

async function logActivity(entry) {
    try {
        const { insertActivityLog } = await import('../services/activityLogService.js');
        await insertActivityLog(entry);
    } catch (err) {
        console.error('[leadsController] activity log failed:', err.message);
    }
}

/**
 * GET /api/leads/folders — folder cards with contact counts + per-folder message
 */
export const getLeadFolders = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            `SELECT
                COALESCE(NULLIF(TRIM(l.lead_group), ''), $2) AS name,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE l.lead_status = 'New')::int AS new_count,
                COUNT(*) FILTER (WHERE l.lead_status = 'Contacted')::int AS contacted_count,
                MAX(l.created_at) AS last_lead_at,
                f.followup_message,
                f.source_hint,
                f.created_at AS folder_created_at
             FROM leads l
             LEFT JOIN lead_folders f
               ON f.user_id = l.user_id
              AND f.name = COALESCE(NULLIF(TRIM(l.lead_group), ''), $2)
             WHERE l.user_id = $1
             GROUP BY 1, f.followup_message, f.source_hint, f.created_at
             ORDER BY MAX(l.created_at) DESC`,
            [userId, DEFAULT_LEAD_GROUP]
        );

        const orphanFolders = await pool.query(
            `SELECT f.name, f.followup_message, f.source_hint, f.created_at AS folder_created_at,
                    0::int AS total, 0::int AS new_count, 0::int AS contacted_count, f.updated_at AS last_lead_at
             FROM lead_folders f
             WHERE f.user_id = $1
               AND NOT EXISTS (
                 SELECT 1 FROM leads l
                 WHERE l.user_id = $1
                   AND COALESCE(NULLIF(TRIM(l.lead_group), ''), $2) = f.name
               )`,
            [userId, DEFAULT_LEAD_GROUP]
        );

        const folders = [...result.rows, ...orphanFolders.rows].sort(
            (a, b) => new Date(b.last_lead_at || 0) - new Date(a.last_lead_at || 0)
        );

        return res.status(200).json({ success: true, folders });
    } catch (err) {
        console.error('[getLeadFolders] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * PUT /api/leads/folders/message — save follow-up copy for one folder
 */
export const updateFolderMessage = async (req, res) => {
    try {
        const { name, followup_message: followupMessage } = req.body;
        if (!name?.trim()) {
            return res.status(400).json({ success: false, message: 'Folder name is required.' });
        }
        const folderName = await upsertLeadFolder(req.user.id, name, {
            followupMessage: followupMessage ?? '',
        });
        return res.status(200).json({
            success: true,
            folder: { name: folderName, followup_message: followupMessage?.trim() || null },
        });
    } catch (err) {
        console.error('[updateFolderMessage] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const getLeads = async (req, res) => {
    try {
        const { search, source, status, group, startDate, endDate, ids } = req.query;
        let query = `SELECT * FROM leads WHERE user_id = $1`;
        const params = [req.user.id];
        let paramIndex = 2;

        if (ids) {
            const idList = String(ids)
                .split(',')
                .map((v) => parseInt(v, 10))
                .filter((n) => Number.isFinite(n) && n > 0);
            if (idList.length > 0) {
                query += ` AND id = ANY($${paramIndex})`;
                params.push(idList);
                paramIndex++;
            }
        }

        if (search) {
            query += ` AND (
                full_name ILIKE $${paramIndex}
                OR email ILIKE $${paramIndex}
                OR phone ILIKE $${paramIndex}
                OR COALESCE(lead_group, '') ILIKE $${paramIndex}
                OR COALESCE(notes, '') ILIKE $${paramIndex}
            )`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (source) {
            query += ` AND source = $${paramIndex}`;
            params.push(source);
            paramIndex++;
        }

        if (status) {
            query += ` AND lead_status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (group) {
            query += ` AND lead_group = $${paramIndex}`;
            params.push(group);
            paramIndex++;
        }

        if (startDate) {
            query += ` AND created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        query += ` ORDER BY created_at DESC`;

        const result = await pool.query(query, params);

        const groupsRes = await pool.query(
            `SELECT DISTINCT COALESCE(NULLIF(TRIM(lead_group), ''), $2) AS lead_group
             FROM leads WHERE user_id = $1 ORDER BY 1`,
            [req.user.id, DEFAULT_LEAD_GROUP]
        );

        return res.status(200).json({
            success: true,
            leads: sanitizeLeads(result.rows),
            groups: groupsRes.rows.map((r) => r.lead_group),
        });
    } catch (err) {
        console.error('[getLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const updateLeadStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { lead_status, notes, lead_group } = req.body;
        const normalizedGroup =
            lead_group !== undefined && lead_group !== null
                ? normalizeLeadGroup(lead_group)
                : undefined;

        const result = await pool.query(
            `UPDATE leads 
             SET lead_status = COALESCE($1, lead_status), 
                 notes = COALESCE($2, notes),
                 lead_group = COALESCE($3, lead_group),
                 updated_at = NOW()
             WHERE id = $4 AND user_id = $5
             RETURNING *`,
            [lead_status, notes, normalizedGroup ?? null, id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        return res.status(200).json({ success: true, lead: sanitizeLeadRow(result.rows[0]) });
    } catch (err) {
        console.error('[updateLeadStatus] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

function resolveImportPurpose(body) {
    const { importPurpose, skipCapture } = body;
    if (importPurpose === 'capture' || importPurpose === 'followup' || importPurpose === 'review') {
        return importPurpose;
    }
    return skipCapture ? 'followup' : 'capture';
}

/** After all import chunks: owner alert + lead messages matched to employee type. */
async function runPostImportMessaging(userId, defaultGroup, {
    importPurpose,
    notifyImportedCount,
    followupMessage,
    sourceHint,
    fileDups = 0,
    dbDups = 0,
}) {
    const recentRes = await pool.query(
        `SELECT l.*, rfs.google_review_url, rfs.automation_id
         FROM leads l
         LEFT JOIN review_funnel_settings rfs ON rfs.user_id = l.user_id
         WHERE l.user_id = $1
           AND COALESCE(NULLIF(TRIM(l.lead_group), ''), $2) = $3
           AND l.lead_status = 'New'
           AND l.created_at > NOW() - INTERVAL '20 minutes'`,
        [userId, DEFAULT_LEAD_GROUP, defaultGroup]
    );
    const batchLeads = recentRes.rows;
    const imported = notifyImportedCount ?? batchLeads.length;
    if (imported < 1 && batchLeads.length < 1) return;

    const [captureRes, followupRes] = await Promise.all([
        pool.query(
            `SELECT auto_response_message, google_review_url, lead_capture_active, automation_id,
                    whatsapp_enabled, email_enabled
             FROM review_funnel_settings WHERE user_id = $1`,
            [userId],
        ).catch(() => ({ rows: [] })),
        pool.query(
            `SELECT is_active, message, whatsapp_enabled, email_enabled
             FROM lead_followup_settings WHERE user_id = $1`,
            [userId],
        ).catch(() => ({ rows: [] })),
    ]);

    const captureCfg = captureRes.rows[0];
    const followupCfg = followupRes.rows[0];
    const followupActive = !!followupCfg?.is_active;

    const { notifyOwnerLeadImportComplete } = await import('../services/ownerNotifyService.js');
    await notifyOwnerLeadImportComplete(userId, {
        imported,
        folderName: defaultGroup,
        fileDups,
        dbDups,
        importPurpose,
    }).catch((err) => {
        console.error('[importLeads] Owner import notify failed:', err.message);
    });

    if (importPurpose === 'capture') {
        if (!captureCfg?.lead_capture_active || !captureCfg?.auto_response_message?.trim()) {
            console.warn('[importLeads] Capture import — capture employee inactive or no message');
            return;
        }
        const targets = batchLeads.filter((l) => l.email || l.phone);
        const results = await Promise.allSettled(
            targets.map((lead) =>
                dispatchFollowupForLead(
                    userId,
                    {
                        ...lead,
                        automation_id: captureCfg.automation_id,
                        google_review_url: captureCfg.google_review_url,
                    },
                    captureCfg.auto_response_message,
                    'Thanks for reaching out!',
                    {
                        whatsappEnabled: captureCfg.whatsapp_enabled,
                        emailEnabled: captureCfg.email_enabled,
                    },
                ),
            ),
        );
        const sent = results.filter((x) => x.status === 'fulfilled' && x.value !== 'none').length;
        console.log(`[importLeads] Capture messages: ${sent}/${targets.length}`);
        const { notifyOwnerBulkSendComplete } = await import('../services/ownerNotifyService.js');
        await notifyOwnerBulkSendComplete(userId, {
            purpose: 'capture',
            sent,
            total: targets.length,
            folderName: defaultGroup,
        }).catch(() => {});
        return;
    }

    if (importPurpose === 'followup') {
        if (!followupActive) {
            console.warn('[importLeads] Follow-up import — follow-up employee inactive');
            return;
        }
        const result = await executeBulkLeadMessaging(userId, {
            group: defaultGroup,
            purpose: 'followup',
            message: followupMessage?.trim() || undefined,
            notifyOwner: true,
        });
        console.log(`[importLeads] Follow-up bulk: ${result.sent}/${result.total}`);
        return;
    }

    if (importPurpose === 'review') {
        const result = await executeBulkLeadMessaging(userId, {
            group: defaultGroup,
            purpose: 'review',
            notifyOwner: true,
        });
        console.log(`[importLeads] Review bulk: ${result.sent}/${result.total}`);
    }
}

export const importLeads = async (req, res) => {
    try {
        const {
            leads,
            skipCapture,
            leadGroup: importDefaultGroup,
            folderName,
            followupMessage,
            sourceHint,
            importPurpose: importPurposeBody,
            runPostImport,
            notifyImportedCount,
        } = req.body;
        const defaultGroup = normalizeLeadGroup(
            folderName || importDefaultGroup,
            DEFAULT_LEAD_GROUP
        );
        const userId = req.user.id;
        const importPurpose = resolveImportPurpose(req.body);

        if (runPostImport && (!Array.isArray(leads) || leads.length === 0)) {
            const count = Number(notifyImportedCount) || 0;
            if (count < 1) {
                return res.status(200).json({
                    success: true,
                    message: 'Import complete',
                    imported: 0,
                    messagingOnly: true,
                });
            }
            res.status(200).json({
                success: true,
                message: 'Sending messages',
                imported: 0,
                messagingOnly: true,
            });
            runPostImportMessaging(userId, defaultGroup, {
                importPurpose,
                notifyImportedCount: count,
                followupMessage,
                sourceHint,
                fileDups: Number(req.body.fileDups) || 0,
                dbDups: Number(req.body.dbDups) || 0,
            }).catch((err) => {
                console.error('[importLeads] Post-import messaging failed:', err.message);
            });
            return;
        }

        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ success: false, message: 'No leads provided' });
        }

        // 1. Dedup within batch — mark as duplicate if email matches OR phone matches
        const seenEmail = new Set();
        const seenPhone = new Set();
        let fileDups = 0;
        console.log(`[importLeads] Starting within-file dedup for ${leads.length} leads`);
        const batchUnique = leads.filter(l => {
            const emailKey = (l.email || '').toLowerCase().trim();
            const phoneKey = (l.phone || '').replace(/\D/g, '');
            // Check if this lead matches any previously seen (by email OR phone)
            if (emailKey && seenEmail.has(emailKey)) { 
                console.log(`[importLeads] File dup found by email: ${emailKey}`);
                fileDups++; 
                return false; 
            }
            if (phoneKey && seenPhone.has(phoneKey)) { 
                console.log(`[importLeads] File dup found by phone: ${phoneKey}`);
                fileDups++; 
                return false; 
            }
            // Track both keys for this lead
            if (emailKey) seenEmail.add(emailKey);
            if (phoneKey) seenPhone.add(phoneKey);
            return true;
        });
        console.log(`[importLeads] Within-file dedup: ${leads.length} → ${batchUnique.length} unique, ${fileDups} duplicates`);

        // 2. Fetch automation configs + check existing duplicates — all in parallel
        const batchEmails = batchUnique.map(l => (l.email || '').toLowerCase().trim()).filter(Boolean);
        const batchPhones = batchUnique.map(l => (l.phone || '').replace(/\D/g, '')).filter(Boolean);

        const dupConditions = [];
        const dupParams = [userId];
        if (batchEmails.length > 0) {
            dupParams.push(batchEmails);
            dupConditions.push(`(email != '' AND lower(email) = ANY($${dupParams.length}))`);
        }
        if (batchPhones.length > 0) {
            dupParams.push(batchPhones);
            dupConditions.push(`(phone != '' AND regexp_replace(phone, '[^0-9]', '', 'g') = ANY($${dupParams.length}))`);
        }

        const [captureRes, followupRes, existingRes] = await Promise.all([
            pool.query(`SELECT auto_response_message, google_review_url, lead_capture_active, automation_id, whatsapp_enabled, email_enabled FROM review_funnel_settings WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] })),
            pool.query(`SELECT is_active FROM lead_followup_settings WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] })),
            dupConditions.length > 0
                ? pool.query(
                    `SELECT lower(email) AS email, regexp_replace(phone, '[^0-9]', '', 'g') AS phone
                     FROM leads WHERE user_id = $1 AND (${dupConditions.join(' OR ')})`,
                    dupParams
                ).catch(() => ({ rows: [] }))
                : Promise.resolve({ rows: [] }),
        ]);

        const captureCfg = captureRes.rows[0];
        const followupActive = followupRes.rows[0]?.is_active;

        const existingEmails = new Set(existingRes.rows.map(r => r.email).filter(Boolean));
        const existingPhones = new Set(existingRes.rows.map(r => r.phone).filter(Boolean));

        // 3. Filter out DB duplicates
        let dbDups = 0;
        console.log(`[importLeads] Checking ${batchUnique.length} leads against DB. Existing emails: ${existingEmails.size}, phones: ${existingPhones.size}`);
        const newLeads = batchUnique.filter(l => {
            const email = (l.email || '').toLowerCase().trim();
            const phone = (l.phone || '').replace(/\D/g, '');
            if (email && existingEmails.has(email)) { 
                console.log(`[importLeads] DB dup found by email: ${email}`);
                dbDups++; 
                return false; 
            }
            if (phone && existingPhones.has(phone)) { 
                console.log(`[importLeads] DB dup found by phone: ${phone}`);
                dbDups++; 
                return false; 
            }
            return true;
        });
        console.log(`[importLeads] After DB dedup: ${batchUnique.length} → ${newLeads.length} new, ${dbDups} DB duplicates`);

        if (newLeads.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'All contacts already exist — nothing new added',
                imported: 0,
                fileDups,
                dbDups,
                total: leads.length,
            });
        }

        // 4. Bulk INSERT — cron timing depends on which employee owns this import
        let lastFollowupAt = null;
        if (importPurpose === 'followup' && followupActive) {
            lastFollowupAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
        } else if (importPurpose === 'capture' && followupActive) {
            lastFollowupAt = new Date().toISOString();
        }

        const names    = newLeads.map(l => l.full_name || extractNameFromEmail(l.email) || 'Imported Lead');
        const emails   = newLeads.map(l => (l.email || '').trim());
        const phones   = newLeads.map(l => (l.phone || '').trim());
        const notesArr = newLeads.map(l => l.notes || '');
        const sources  = newLeads.map(l => l.source || 'Imported');
        // Always use the user-chosen list name — ignore industry/category columns in the file.
        const groups   = newLeads.map(() => defaultGroup);

        const insertRes = await pool.query(
            `INSERT INTO leads
                 (user_id, full_name, email, phone, notes, source, lead_group, lead_status, marketing_consent, followup_step_index, last_followup_at, created_at)
             SELECT $1,
                    unnest($2::text[]),
                    unnest($3::text[]),
                    unnest($4::text[]),
                    unnest($5::text[]),
                    unnest($6::text[]),
                    unnest($7::text[]),
                    'New', true, 0, $8, NOW()
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [userId, names, emails, phones, notesArr, sources, groups, lastFollowupAt]
        );

        const savedLeads = insertRes.rows;
        const isReviewImport =
            importPurpose === 'review' || /review\s*funnel/i.test(String(sourceHint || ''));

        if (savedLeads.length > 0) {
            try {
                await upsertLeadFolder(userId, defaultGroup, {
                    followupMessage,
                    sourceHint: sourceHint || savedLeads[0]?.source || 'import',
                });
            } catch (folderErr) {
                console.error('[importLeads] lead_folders upsert failed:', folderErr.message);
            }

            try {
                await logActivity({
                    userId,
                    automationName: isReviewImport ? 'Review Funnel' : 'Lead Import',
                    triggerType: isReviewImport ? 'Review request batch' : 'Contact import',
                    status: 'Success',
                    detail: `${savedLeads.length} contact${savedLeads.length === 1 ? '' : 's'} added to ${defaultGroup}`,
                    metadata: {
                        folder: defaultGroup,
                        source: sourceHint || 'import',
                        lead_ids: savedLeads.map((l) => l.id),
                    },
                });
            } catch (logErr) {
                console.error('[importLeads] activity log failed:', logErr.message);
            }
        }

        // Respond immediately — messaging is fire-and-forget
        res.status(200).json({
            success: true,
            message: `${savedLeads.length} contacts imported`,
            imported: savedLeads.length,
            fileDups,
            dbDups,
            total: leads.length,
            folderName: defaultGroup,
            followupMessage: followupMessage?.trim() || null,
        });

        if (savedLeads.length === 0) return;

        if (req.body.runPostImport) {
            runPostImportMessaging(userId, defaultGroup, {
                importPurpose: isReviewImport ? 'review' : importPurpose,
                notifyImportedCount: Number(notifyImportedCount) || savedLeads.length,
                followupMessage,
                sourceHint,
                fileDups,
                dbDups,
            }).catch((err) => {
                console.error('[importLeads] Post-import messaging failed:', err.message);
            });
        }
    } catch (err) {
        console.error('[importLeads] Error:', err.message, err.code || '', err.detail || '');
        if (!res.headersSent) {
            const hint =
                err.code === '42703'
                    ? 'Database schema is out of date — redeploy the API to run migrations.'
                    : err.message?.includes('lead_folders')
                      ? 'Lead folders table issue — redeploy the API.'
                      : null;
            res.status(500).json({
                success: false,
                message: hint || 'Import failed. Please try again.',
            });
        }
    }
};

export const triggerLeadFollowup = async (req, res) => {
    const startTime = Date.now();
    try {
        const { id } = req.params;
        const { message: messageOverride } = req.body || {};
        
        // Fetch lead and ALL relevant user configs
        const query = `
            SELECT 
                l.*, 
                u.company_name, u.email as owner_email, 
                rfs.auto_response_message as funnel_msg, rfs.google_review_url, rfs.notification_email, rfs.whatsapp_number_fallback,
                lfs.followup_sequence, lfs.is_active as lfs_active,
                lfs.whatsapp_enabled as lfs_whatsapp_enabled,
                lfs.email_enabled as lfs_email_enabled
            FROM leads l
            JOIN users u ON l.user_id = u.id
            LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
            LEFT JOIN lead_followup_settings lfs ON lfs.user_id = u.id
            WHERE l.id = $1 AND l.user_id = $2
        `;
        const leadResult = await pool.query(query, [id, req.user.id]);

        if (leadResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        const lead = leadResult.rows[0];
        console.log(`[triggerLeadFollowup][${Date.now() - startTime}ms] Found lead ${id}`);

        // Determine which message to send
        let messageToSend = lead.funnel_msg; // Default to funnel auto-response
        
        const sequence = typeof lead.followup_sequence === 'string' 
            ? JSON.parse(lead.followup_sequence) 
            : (lead.followup_sequence || []);

        if (sequence.length > 0) {
            const currentIndex = lead.followup_step_index || 0;
            if (currentIndex < sequence.length) {
                messageToSend = sequence[currentIndex].message;
            }
        }

        if (!messageToSend) {
            messageToSend = 'Hi {name}! Thanks for reaching out.';
        }

        if (messageOverride?.trim()) {
            messageToSend = messageOverride.trim();
        } else {
            const folderMsg = await getFolderMessage(
                req.user.id,
                lead.lead_group || DEFAULT_LEAD_GROUP
            );
            if (folderMsg) messageToSend = folderMsg;
        }

        // Determine subject: First message vs follow-up
        const isFirstMessage = (lead.followup_step_index || 0) === 0;
        const subject = isFirstMessage ? 'Thanks for reaching out!' : `Follow-up from ${lead.company_name || 'Our Team'}`;

        // Dispatch via internal cascade only: WhatsApp native → email.
        const channel = await dispatchFollowupForLead(req.user.id, lead, messageToSend, subject, {
            whatsappEnabled: lead.lfs_whatsapp_enabled,
            emailEnabled: lead.lfs_email_enabled,
        });

        // Update status and increment sequence index so cron picks up the NEXT one
        await pool.query(
            `UPDATE leads 
             SET lead_status = 'Contacted', 
                 followup_step_index = followup_step_index + 1, 
                 last_followup_at = NOW(), 
                 updated_at = NOW() 
             WHERE id = $1`,
            [id]
        );

        await logActivity({
            userId: req.user.id,
            automationName: 'Lead Follow-up',
            triggerType: 'Manual Trigger',
            status: 'Success',
            detail: `Follow-up sent via ${channel}`,
            metadata: { lead_id: id, provider: channel },
        });

        console.log(`[triggerLeadFollowup][${Date.now() - startTime}ms] ✅ Success via ${channel}`);
        return res.status(200).json({ success: true, message: `Follow-up sent via ${channel}`, provider: channel });

    } catch (err) {
        console.error(`[triggerLeadFollowup][${Date.now() - startTime}ms] ❌ Error:`, err.message);
        try {
            const { insertActivityLog } = await import('../services/activityLogService.js');
            await insertActivityLog({
                userId: req.user.id,
                automationName: 'Lead Follow-up',
                triggerType: 'Manual Trigger',
                status: 'Failed',
                detail: err.message || 'Failed to send follow-up',
                metadata: { lead_id: req.params.id },
            });
        } catch {
            /* noop */
        }
        return res.status(502).json({
            success: false,
            message: err.message?.includes('reconnect')
                ? err.message
                : 'Could not send follow-up. Check WhatsApp and Gmail under Integrations.',
        });
    }
};

export const triggerBulkFollowup = async (req, res) => {
    try {
        const { ids, message: messageOverride, group: groupFilter, purpose } = req.body;

        if ((Array.isArray(ids) && ids.length > 0) || groupFilter?.trim()) {
            const result = await executeBulkLeadMessaging(req.user.id, {
                ids,
                message: messageOverride,
                group: groupFilter,
                purpose,
                notifyOwner: true,
            });
            const label = purpose === 'review' ? 'review requests' : 'follow-ups';
            return res.status(200).json({
                success: true,
                message:
                    result.total === 0
                        ? 'No leads to message'
                        : `${result.sent} ${label} sent`,
                triggered: result.sent,
            });
        }

        // Fallback to original logic (recent imports)
        const cfgRes = await pool.query(
            `SELECT message, followup_sequence, is_active FROM lead_followup_settings WHERE user_id = $1`,
            [req.user.id]
        );
        const cfg = cfgRes.rows[0];
        if (!cfg?.is_active) {
            return res.status(200).json({ success: true, message: 'Follow-up agent is off duty' });
        }

        // Get leads imported in the last 60 minutes with status New that haven't been scheduled yet
        const leadsRes = await pool.query(
            `SELECT * FROM leads WHERE user_id = $1 AND lead_status = 'New' 
             AND created_at > NOW() - INTERVAL '60 minutes' 
             AND last_followup_at IS NULL`,
            [req.user.id]
        );

        const leads = leadsRes.rows;
        if (leads.length === 0) {
            return res.status(200).json({ success: true, message: 'No new leads to schedule', scheduled: 0 });
        }

        // Schedule them for cron processing by setting last_followup_at = NOW()
        await pool.query(
            `UPDATE leads SET followup_step_index = 0, last_followup_at = NOW() 
             WHERE id = ANY($1) AND user_id = $2`,
            [leads.map(l => l.id), req.user.id]
        );

        res.status(200).json({ 
            success: true, 
            message: `${leads.length} leads scheduled for follow-up`,
            scheduled: leads.length 
        });

        console.log(`[triggerBulkFollowup] ${leads.length} leads scheduled. Cron will send first message immediately.`);
    } catch (err) {
        console.error('[triggerBulkFollowup] Error:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error' });
    }
};

function inferTimelineType(detail = '', triggerType = '') {
    const text = `${detail} ${triggerType}`.toLowerCase();
    if (text.includes('whatsapp') || text.includes('wa.me')) return 'whatsapp';
    if (text.includes('email') || text.includes('gmail')) return 'email';
    if (text.includes('call') || text.includes('phone')) return 'call';
    return 'note';
}

/** GET /api/leads/:id/timeline — activity for lead detail modal */
export const getLeadTimeline = async (req, res) => {
    try {
        const { id } = req.params;
        const leadRes = await pool.query(
            `SELECT id, full_name, source, lead_group, created_at, last_followup_at, lead_status
             FROM leads WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        );
        if (leadRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }
        const lead = leadRes.rows[0];
        const timeline = [];

        timeline.push({
            type: 'note',
            title: 'Lead captured',
            description: [lead.source, lead.lead_group].filter(Boolean).join(' · ') || undefined,
            timestamp: lead.created_at,
        });

        const logsRes = await pool.query(
            `SELECT automation_name, trigger_type, status, detail, metadata, created_at
             FROM activity_logs
             WHERE user_id = $1
               AND (
                 metadata->>'lead_id' = $2
                 OR metadata->>'leadId' = $2
               )
             ORDER BY created_at DESC
             LIMIT 80`,
            [req.user.id, String(id)]
        );

        for (const log of logsRes.rows) {
            const detail = log.detail || '';
            timeline.push({
                type: inferTimelineType(detail, log.trigger_type || ''),
                title: log.trigger_type || log.automation_name || 'Activity',
                description: [detail, log.status].filter(Boolean).join(' · ') || undefined,
                timestamp: log.created_at,
            });
        }

        if (lead.last_followup_at) {
            const alreadyLogged = timeline.some(
                (e) => e.title?.toLowerCase().includes('follow-up') || e.title?.toLowerCase().includes('followup')
            );
            if (!alreadyLogged) {
                timeline.push({
                    type: 'whatsapp',
                    title: 'Follow-up sent',
                    description: lead.lead_status === 'Contacted' ? 'Marked as contacted' : undefined,
                    timestamp: lead.last_followup_at,
                });
            }
        }

        timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        return res.status(200).json({ success: true, timeline });
    } catch (err) {
        console.error('[getLeadTimeline] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const deleteLead = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        // Verify the lead belongs to this user
        const checkRes = await pool.query(
            `SELECT id FROM leads WHERE id = $1 AND user_id = $2`,
            [id, userId]
        );

        if (checkRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        // Delete the lead
        await pool.query(`DELETE FROM leads WHERE id = $1`, [id]);

        return res.status(200).json({ success: true, message: 'Lead deleted successfully' });
    } catch (err) {
        console.error('[deleteLead] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error deleting lead' });
    }
};

export const bulkDeleteLeads = async (req, res) => {
    try {
        const { ids } = req.body;
        const userId = req.user.id;

        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid IDs array' });
        }

        // Delete leads that belong to this user
        const result = await pool.query(
            `DELETE FROM leads WHERE id = ANY($1) AND user_id = $2 RETURNING id`,
            [ids, userId]
        );

        return res.status(200).json({ 
            success: true, 
            message: `${result.rowCount} leads deleted successfully`,
            deletedCount: result.rowCount
        });
    } catch (err) {
        console.error('[bulkDeleteLeads] Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error deleting leads' });
    }
};
