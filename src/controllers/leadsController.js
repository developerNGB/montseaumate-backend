import pool from '../db/pool.js';
import { frontendBaseUrl } from '../utils/publicUrls.js';
import { injectPlaceholders, createEmailTemplate } from '../utils/templateUtils.js';
import * as whatsappService from '../services/whatsappService.js';
import { sendDynamicEmail } from '../services/emailService.js';
import { sanitizeLeadRow, sanitizeLeadEmailForPublic, sanitizeLeads } from '../utils/leadPrivacy.js';
import { retryAsync } from '../utils/retryAsync.js';
import { normalizeLeadGroup, DEFAULT_LEAD_GROUP } from '../utils/leadGroups.js';
import { upsertLeadFolder, getFolderMessage } from '../utils/leadFolders.js';

/**
 * Extract a name from email address (e.g., info@company.com → Info, john.smith@email.com → John Smith)
 */
const extractNameFromEmail = (email) => {
    if (!email) return null;
    const localPart = email.split('@')[0];
    // Remove numbers and split by common separators
    const parts = localPart.replace(/[0-9]/g, '').split(/[._\-]/).filter(p => p.length > 1);
    if (parts.length === 0) return null;
    // Capitalize each part
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
};

/**
 * Dispatch a follow-up message to a single lead.
 * Priority: WhatsApp native → email cascade. No external automation service.
 * Never throws — logs errors and continues.
 * @param {string} subject - Optional custom subject line
 */
const dispatchFollowup = async (userId, lead, message, subject = 'Message from Our Team', options = {}) => {
    const dispatchStart = Date.now();
    const whatsappEnabled = options.whatsappEnabled !== false;
    const emailEnabled = options.emailEnabled !== false;
    const recipientEmail = sanitizeLeadEmailForPublic(lead.email);
    // Name handling: use provided name, or extract from email, or fallback to "there"
    const leadName = lead.full_name && lead.full_name !== 'there' && lead.full_name !== 'Imported Lead'
        ? lead.full_name
        : extractNameFromEmail(recipientEmail) || 'there';
    
    const origin = frontendBaseUrl() || '';
    if (!origin) {
        console.error('[dispatchFollowup] FRONTEND_URL is not set; review/funnel links in messages may be wrong');
    }
    const link = lead.automation_id ? `${origin}/r/${lead.automation_id}` : origin;

    const personalisedMsg = injectPlaceholders(message || 'Hi {name}! Thanks for reaching out.', {
        name: leadName,
        full_name: leadName,
        link: link,
        reviewUrl: link,
        googleReviewUrl: lead.google_review_url,
        company: lead.company_name || 'Our Team'
    });

    console.log(`[Followup][${dispatchStart}] Dispatching to ${recipientEmail || lead.phone || 'unknown'} (ID: ${lead.id || 'new'}, Name: ${leadName})`);

    const sentChannels = [];

    // 1. Native WhatsApp
    if (whatsappEnabled && lead.phone) {
        try {
            console.log(`[Followup][${Date.now() - dispatchStart}ms] 📱 Attempting WhatsApp to ${lead.phone}...`);
            const waInt = await pool.query(
                `SELECT access_token FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
                [userId]
            );
            if (waInt.rows[0]?.access_token === 'whatsapp_native_session') {
                await retryAsync(
                    () => whatsappService.sendWhatsAppMessage(userId, lead.phone, personalisedMsg),
                    { attempts: 3, delayMs: 1000 }
                );
                console.log(`[Followup][${Date.now() - dispatchStart}ms] ✅ WhatsApp sent`);
                sentChannels.push('whatsapp');
            }
        } catch (e) {
            console.warn(`[Followup][${Date.now() - dispatchStart}ms] WhatsApp failed:`, e.message);
        }
    }

    // 2. Email - via emailService cascade: SMTP → Microsoft → Google → system gmail
    if (emailEnabled && recipientEmail) {
        try {
            console.log(`[Followup][${Date.now() - dispatchStart}ms] 📧 Attempting email to ${recipientEmail}...`);
            const result = await retryAsync(
                () =>
                    sendDynamicEmail(userId, {
                        to: recipientEmail,
                        subject: subject,
                        text: personalisedMsg,
                        html: createEmailTemplate(personalisedMsg, leadName, subject),
                    }),
                { attempts: 3, delayMs: 1000 }
            );
            console.log(`[Followup][${Date.now() - dispatchStart}ms] ✅ Email sent via ${result.provider || 'unknown'}`);
            sentChannels.push(result.provider || 'email');
        } catch (e) {
            console.error(`[Followup][${Date.now() - dispatchStart}ms] ❌ Email failed:`, e.message);
            if (sentChannels.length === 0 && (e.message.includes('expired') || e.message.includes('permission') || e.message.includes('Invalid recipient'))) {
                throw e;
            }
        }
    }

    if (sentChannels.length > 0) {
        return sentChannels.join('+');
    }

    console.warn(`[Followup][${Date.now() - dispatchStart}ms] ❌ No channel available for lead ${lead.id || lead.email || lead.phone}`);
    return 'none';
};

/** Exported for activity-log retry and internal tooling */
export const dispatchFollowupForLead = dispatchFollowup;

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
        const { search, source, status, group, startDate, endDate } = req.query;
        let query = `SELECT * FROM leads WHERE user_id = $1`;
        const params = [req.user.id];
        let paramIndex = 2;

        if (search) {
            query += ` AND (full_name ILIKE $${paramIndex} OR email ILIKE $${paramIndex} OR phone ILIKE $${paramIndex})`;
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

export const importLeads = async (req, res) => {
    try {
        const {
            leads,
            skipCapture,
            leadGroup: importDefaultGroup,
            folderName,
            followupMessage,
            sourceHint,
        } = req.body;
        const defaultGroup = normalizeLeadGroup(
            folderName || importDefaultGroup,
            DEFAULT_LEAD_GROUP
        );
        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ success: false, message: 'No leads provided' });
        }

        const userId = req.user.id;

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
        const captureActive = !skipCapture && captureCfg?.lead_capture_active && captureCfg?.auto_response_message;

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

        // 4. Bulk INSERT — single DB round-trip via unnest()
        // Logic for scheduling follow-ups:
        // - If we are sending a "Lead Capture" message now (captureActive), set last_followup_at = NOW()
        //   so that the cron job waits for the first follow-up delay before sending.
        // - If we are NOT sending a capture message (captureActive=false), set last_followup_at = 1 year ago
        //   so that the cron job picks up the first follow-up message IMMEDIATELY.
        const lastFollowupAt = followupActive 
            ? (captureActive 
                ? new Date().toISOString() 
                : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString())
            : null;

        const names    = newLeads.map(l => l.full_name || extractNameFromEmail(l.email) || 'Imported Lead');
        const emails   = newLeads.map(l => (l.email || '').trim());
        const phones   = newLeads.map(l => (l.phone || '').trim());
        const notesArr = newLeads.map(l => l.notes || '');
        const sources  = newLeads.map(l => l.source || 'Imported');
        const groups   = newLeads.map(l => normalizeLeadGroup(l.lead_group || l.group, defaultGroup));

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

        if (savedLeads.length > 0) {
            try {
                await upsertLeadFolder(userId, defaultGroup, {
                    followupMessage,
                    sourceHint: sourceHint || savedLeads[0]?.source || 'import',
                });
            } catch (folderErr) {
                console.error('[importLeads] lead_folders upsert failed:', folderErr.message);
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

        // 5. Fire-and-forget capture auto-responses
        if (captureActive) {
            Promise.allSettled(
                savedLeads.filter(l => l.email || l.phone).map(lead =>
                    dispatchFollowup(userId, { ...lead, automation_id: captureCfg.automation_id, google_review_url: captureCfg.google_review_url }, captureCfg.auto_response_message, 'Thanks for reaching out!', {
                        whatsappEnabled: captureCfg.whatsapp_enabled,
                        emailEnabled: captureCfg.email_enabled,
                    })
                )
            ).then(results => {
                const sent = results.filter(x => x.status === 'fulfilled' && x.value !== 'none').length;
                console.log(`[importLeads] Auto-response: ${sent}/${savedLeads.length} sent`);
            });
        }

        if (followupActive) {
            console.log(`[importLeads] ${savedLeads.length} leads queued for follow-up cron`);
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
        const channel = await dispatchFollowup(req.user.id, lead, messageToSend, subject, {
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

        // Log activity
        await pool.query(
            `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, created_at)
             VALUES ($1, $2, $3, 'Success', $4, NOW())`,
            [req.user.id, 'Lead Follow-up', 'Manual Trigger', 'Follow-up sent']
        );

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
        const { ids, message: messageOverride, group: groupFilter } = req.body;

        const resolveMessageForLead = async (lead, cfg) => {
            if (messageOverride?.trim()) return messageOverride.trim();
            const folderMsg = await getFolderMessage(
                req.user.id,
                lead.lead_group || DEFAULT_LEAD_GROUP
            );
            if (folderMsg) return folderMsg;
            const sequence =
                typeof cfg?.followup_sequence === 'string'
                    ? JSON.parse(cfg.followup_sequence)
                    : cfg?.followup_sequence || [];
            if (sequence.length > 0) {
                const idx = lead.followup_step_index || 0;
                if (sequence[idx]?.message) return sequence[idx].message;
            }
            return cfg?.message || 'Hi {name}! Thanks for reaching out.';
        };

        // If IDs are provided, trigger for those specific leads
        if (Array.isArray(ids) && ids.length > 0) {
            const cfgRes = await pool.query(
                `SELECT lfs.message, lfs.followup_sequence, lfs.is_active,
                        lfs.whatsapp_enabled, lfs.email_enabled,
                        u.company_name,
                        rfs.google_review_url, rfs.automation_id
                 FROM lead_followup_settings lfs
                 JOIN users u ON u.id = lfs.user_id
                 LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
                 WHERE lfs.user_id = $1`,
                [req.user.id]
            );
            const cfg = cfgRes.rows[0];

            const leadsRes = await pool.query(
                `SELECT l.*, u.company_name, rfs.google_review_url, rfs.automation_id
                 FROM leads l
                 JOIN users u ON u.id = l.user_id
                 LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
                 WHERE l.user_id = $1 AND l.id = ANY($2)`,
                [req.user.id, ids]
            );

            const leads = leadsRes.rows;
            if (leads.length === 0) {
                return res.status(200).json({ success: true, message: 'No leads found', triggered: 0 });
            }

            let sent = 0;
            for (const lead of leads) {
                const msg = await resolveMessageForLead(lead, cfg);
                const channel = await dispatchFollowup(req.user.id, lead, msg, 'Message from Our Team', {
                    whatsappEnabled: cfg?.whatsapp_enabled,
                    emailEnabled: cfg?.email_enabled,
                });
                if (channel !== 'none') sent++;
            }

            await pool.query(
                `UPDATE leads SET 
                    lead_status = 'Contacted',
                    followup_step_index = followup_step_index + 1,
                    last_followup_at = NOW(),
                    updated_at = NOW() 
                 WHERE id = ANY($1) AND user_id = $2`,
                [leads.map((l) => l.id), req.user.id]
            );

            await pool.query(
                `INSERT INTO activity_logs (user_id, automation_name, trigger_type, status, detail, created_at)
                 VALUES ($1, $2, $3, 'Success', $4, NOW())`,
                [req.user.id, 'Lead Follow-up', 'Bulk Trigger', `${sent}/${leads.length} follow-up messages sent`]
            );

            return res.status(200).json({
                success: true,
                message: `${sent} follow-ups sent`,
                triggered: sent,
            });
        }

        if (groupFilter?.trim()) {
            const cfgRes = await pool.query(
                `SELECT lfs.message, lfs.followup_sequence, lfs.is_active,
                        lfs.whatsapp_enabled, lfs.email_enabled
                 FROM lead_followup_settings lfs WHERE user_id = $1`,
                [req.user.id]
            );
            const cfg = cfgRes.rows[0];
            const folderName = normalizeLeadGroup(groupFilter);
            const leadsRes = await pool.query(
                `SELECT l.*, u.company_name, rfs.google_review_url, rfs.automation_id
                 FROM leads l
                 JOIN users u ON u.id = l.user_id
                 LEFT JOIN review_funnel_settings rfs ON rfs.user_id = u.id
                 WHERE l.user_id = $1
                   AND COALESCE(NULLIF(TRIM(l.lead_group), ''), $2) = $3
                   AND l.lead_status != 'Contacted'`,
                [req.user.id, DEFAULT_LEAD_GROUP, folderName]
            );
            const leads = leadsRes.rows;
            if (!leads.length) {
                return res.status(200).json({ success: true, message: 'No leads to message in this folder', triggered: 0 });
            }
            let sent = 0;
            for (const lead of leads) {
                const msg = await resolveMessageForLead(lead, cfg);
                const channel = await dispatchFollowup(req.user.id, lead, msg, 'Message from Our Team', {
                    whatsappEnabled: cfg?.whatsapp_enabled,
                    emailEnabled: cfg?.email_enabled,
                });
                if (channel !== 'none') sent++;
            }
            await pool.query(
                `UPDATE leads SET lead_status = 'Contacted', followup_step_index = followup_step_index + 1,
                 last_followup_at = NOW(), updated_at = NOW()
                 WHERE id = ANY($1) AND user_id = $2`,
                [leads.map((l) => l.id), req.user.id]
            );
            return res.status(200).json({ success: true, message: `${sent} messages sent`, triggered: sent });
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
