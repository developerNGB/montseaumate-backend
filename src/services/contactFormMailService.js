import { buildContactFormEmail } from '../utils/contactFormEmail.js';
import { getContactFormInbox } from './supportMailService.js';
import {
    getPlatformGmailFromAddress,
    isPlatformGmailConfigured,
    sendPlatformGmail,
} from './platformGmail.js';

export async function isContactFormMailConfigured() {
    return isPlatformGmailConfigured();
}

/**
 * Landing contact form — platform Gmail only (same path as auth OTP emails).
 * @param {{ name: string, email: string, message: string, source?: string }} payload
 */
export async function sendContactFormNotification({ name, email, message, source }) {
    if (!isPlatformGmailConfigured()) {
        const err = new Error(
            'Contact form email is not configured. Set EMAIL_USER and EMAIL_PASS (Gmail app password) on the API server.',
        );
        err.code = 'contact_sender_not_configured';
        throw err;
    }

    const to = getContactFormInbox();
    const built = buildContactFormEmail({ name, email, message, source });

    const info = await sendPlatformGmail({
        to,
        replyTo: built.replyTo,
        subject: built.subject,
        html: built.html,
        text: built.text,
        from: built.from,
    });

    console.log(
        `[contactForm] Delivered via platform Gmail (${getPlatformGmailFromAddress()}) → ${to} id=${info.messageId}`,
    );

    return { success: true, provider: 'platform_gmail', messageId: info.messageId, to };
}
