import pool from '../db/pool.js';
import { frontendBaseUrl } from '../utils/publicUrls.js';
import { injectPlaceholders, createEmailTemplate } from '../utils/templateUtils.js';
import * as whatsappService from '../services/whatsappService.js';
import { sendDynamicEmail } from '../services/emailService.js';
import { sanitizeLeadEmailForPublic } from '../utils/leadPrivacy.js';
import { retryAsync } from '../utils/retryAsync.js';

const extractNameFromEmail = (email) => {
    if (!email) return null;
    const localPart = email.split('@')[0];
    const parts = localPart.replace(/[0-9]/g, '').split(/[._\-]/).filter((p) => p.length > 1);
    if (parts.length === 0) return null;
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
};

/**
 * Dispatch a follow-up message to a single lead (WhatsApp native → email).
 */
export const dispatchFollowupForLead = async (
    userId,
    lead,
    message,
    subject = 'Message from Our Team',
    options = {}
) => {
    const dispatchStart = Date.now();
    const whatsappEnabled = options.whatsappEnabled !== false;
    const emailEnabled = options.emailEnabled !== false;
    const recipientEmail = sanitizeLeadEmailForPublic(lead.email);
    const leadName =
        lead.full_name && lead.full_name !== 'there' && lead.full_name !== 'Imported Lead'
            ? lead.full_name
            : extractNameFromEmail(recipientEmail) || 'there';

    const origin = frontendBaseUrl() || '';
    if (!origin) {
        console.error('[dispatchFollowup] FRONTEND_URL is not set; review/funnel links in messages may be wrong');
    }
    const link = lead.automation_id ? `${origin}/r/${lead.automation_id}?source=list` : origin;

    const personalisedMsg = injectPlaceholders(message || 'Hi {name}! Thanks for reaching out.', {
        name: leadName,
        full_name: leadName,
        link,
        reviewUrl: link,
        googleReviewUrl: lead.google_review_url,
        company: lead.company_name || 'Our Team',
    });

    console.log(
        `[Followup][${dispatchStart}] Dispatching to ${recipientEmail || lead.phone || 'unknown'} (ID: ${lead.id || 'new'}, Name: ${leadName})`
    );

    const sentChannels = [];

    if (whatsappEnabled && lead.phone) {
        try {
            const waInt = await pool.query(
                `SELECT access_token FROM integrations WHERE user_id = $1 AND provider = 'whatsapp'`,
                [userId]
            );
            if (waInt.rows[0]?.access_token === 'whatsapp_native_session') {
                await retryAsync(
                    () => whatsappService.sendWhatsAppMessage(userId, lead.phone, personalisedMsg),
                    { attempts: 3, delayMs: 1000 }
                );
                sentChannels.push('whatsapp');
            }
        } catch (e) {
            console.warn(`[Followup] WhatsApp failed:`, e.message);
        }
    }

    if (emailEnabled && recipientEmail) {
        try {
            const result = await retryAsync(
                () =>
                    sendDynamicEmail(userId, {
                        to: recipientEmail,
                        subject,
                        text: personalisedMsg,
                        html: createEmailTemplate(personalisedMsg, leadName, subject),
                    }),
                { attempts: 3, delayMs: 1000 }
            );
            sentChannels.push(result.provider || 'email');
        } catch (e) {
            console.error(`[Followup] Email failed:`, e.message);
            if (
                sentChannels.length === 0 &&
                (e.message.includes('expired') ||
                    e.message.includes('permission') ||
                    e.message.includes('Invalid recipient'))
            ) {
                throw e;
            }
        }
    }

    if (sentChannels.length > 0) {
        return sentChannels.join('+');
    }

    console.warn(
        `[Followup] No channel available for lead ${lead.id || lead.email || lead.phone}`
    );
    return 'none';
};
