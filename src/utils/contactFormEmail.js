import crypto from 'crypto';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Standalone contact-form notification (not threaded with follow-ups or system alerts).
 * @param {{ name: string, email: string, message: string, source?: string }} params
 * @returns {import('nodemailer').SendMailOptions}
 */
export function buildContactFormEmail({ name, email, message, source = 'Equipo Experto contact form' }) {
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
    const safeSource = escapeHtml(source);

    const sentAt = new Date();
    const stamp = sentAt.toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Europe/Madrid',
    });
    const token = crypto.randomBytes(4).toString('hex');

    const subjectLabel =
        source === 'Equipo Experto billing inquiry' ? 'billing' : 'contact form';
    const subject = `New Message from ${name} - ${subjectLabel} - ${stamp}`;

    return {
        from: 'Equipo Experto - Contact Form',
        replyTo: `"${name}" <${email}>`,
        subject,
        html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 8px; overflow: hidden;">
                    <div style="background: #1a1a2e; padding: 24px 32px;">
                        <h2 style="color: #ffffff; margin: 0; font-size: 18px; font-weight: 700; letter-spacing: 1px;">NEW CONTACT MESSAGE</h2>
                        <p style="color: rgba(255,255,255,0.5); margin: 4px 0 0; font-size: 12px;">${safeSource}</p>
                    </div>
                    <div style="padding: 32px; background: #ffffff;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 10px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; width: 120px;">Name</td>
                                <td style="padding: 10px 0; font-size: 14px; color: #111;">${safeName}</td>
                            </tr>
                            <tr style="border-top: 1px solid #f0f0f0;">
                                <td style="padding: 10px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888;">Email</td>
                                <td style="padding: 10px 0; font-size: 14px; color: #111;"><a href="mailto:${safeEmail}" style="color: #4f46e5;">${safeEmail}</a></td>
                            </tr>
                            <tr style="border-top: 1px solid #f0f0f0;">
                                <td style="padding: 10px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; vertical-align: top;">Message</td>
                                <td style="padding: 10px 0; font-size: 14px; color: #111; line-height: 1.7;">${safeMessage}</td>
                            </tr>
                        </table>
                    </div>
                    <div style="padding: 16px 32px; background: #f4f4f8; text-align: center;">
                        <p style="margin: 0; font-size: 11px; color: #aaa;">Reply directly to this email to respond to ${safeName}</p>
                    </div>
                </div>
            `,
        text: `NEW CONTACT MESSAGE\n${source}\n\nName: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
        messageId: `<contact-form.${sentAt.getTime()}.${token}@equipoexperto.com>`,
        headers: {
            'X-Entity-Ref-ID': crypto.randomUUID(),
            'X-Contact-Form': 'true',
        },
    };
}
