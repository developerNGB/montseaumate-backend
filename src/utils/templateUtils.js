/**
 * Replaces placeholders like {name} and {link} with actual data.
 */
export const injectPlaceholders = (template, data = {}) => {
    if (!template) return '';
    
    let result = template;
    
    // Replace {name} or {{name}} with data.name, data.full_name, or ''
    const participantName = data.name || data.full_name || '';
    result = result.replace(/{{name}}/gi, participantName);
    result = result.replace(/{name}/gi, participantName);
    
    // Replace {link} or {{link}} with data.link, data.publicUrl, or ''
    const targetLink = resolveMessageLink(template, data);
    result = result.replace(/{{link}}/gi, targetLink);
    result = result.replace(/{link}/gi, targetLink);

    // Replace {number} or {{number}} with data.number or ''
    const contactNumber = data.number || '';
    result = result.replace(/{{number}}/gi, contactNumber);
    result = result.replace(/{number}/gi, contactNumber);
    
    return result;
};

export const looksLikeReviewRequest = (template = '') => {
    const text = String(template).toLowerCase();
    return /\b(review|google|rating|feedback|reseña|valoraci[oó]n|opini[oó]n)\b/.test(text);
};

export const resolveMessageLink = (template, data = {}) => {
    if (looksLikeReviewRequest(template)) {
        return data.googleReviewUrl || data.reviewUrl || data.link || data.publicUrl || '';
    }

    return data.link || data.publicUrl || '';
};

/**
 * Create professional HTML email template
 */
export const createEmailTemplate = (message, leadName, headerText = 'Message from Our Team') => {
    const currentYear = new Date().getFullYear();
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5; }
        .email-wrapper { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { padding: 40px 30px; text-align: center; border-bottom: 3px solid #3b82f6; }
        .header h1 { margin: 0; color: #1f2937; font-size: 24px; font-weight: 600; }
        .content { padding: 40px 30px; }
        .content p { margin: 0 0 20px 0; color: #4b5563; font-size: 16px; line-height: 1.7; }
        .message-box { background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0; }
        .message-box p { margin: 0; color: #374151; }
        .signature { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
        .signature p { margin: 0; color: #6b7280; font-size: 14px; }
        .footer { padding: 30px; text-align: center; background-color: #f9fafb; border-top: 1px solid #e5e7eb; }
        .footer p { margin: 0; color: #9ca3af; font-size: 12px; }
        .button { display: inline-block; padding: 12px 24px; background-color: #3b82f6; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="email-wrapper">
        <div class="header">
            <h1>${headerText}</h1>
        </div>
        <div class="content">
            <div class="message-box">
                <p>${message.replace(/\n/g, '</p><p>')}</p>
            </div>
            <div class="signature">
                <p>Best regards,<br>Customer Success Team</p>
            </div>
        </div>
        <div class="footer">
            <p>This email was sent to you as part of our automated business services.<br>© ${currentYear} All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
};
