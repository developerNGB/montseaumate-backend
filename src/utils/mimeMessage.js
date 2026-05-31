import nodemailer from 'nodemailer';

/** RFC 2047 encoded-word for MIME headers (display names with special characters). */
export function encodeMimeHeaderValue(value) {
    const text = String(value ?? '');
    if (!/[^\x20-\x7E]/.test(text)) return text;
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    return `=?UTF-8?B?${encoded}?=`;
}

function formatFromHeader(displayName, email) {
    const safeName = String(displayName ?? '').replace(/"/g, "'");
    if (!safeName) return email;
    return `${encodeMimeHeaderValue(safeName)} <${email}>`;
}

/**
 * @param {string | undefined} replyTo
 * @returns {{ address: string, name?: string } | null}
 */
export function parseReplyToAddress(replyTo) {
    if (!replyTo) return null;
    const angle = /<([^>]+)>/.exec(replyTo);
    const address = (angle ? angle[1] : replyTo).trim();
    if (!address.includes('@')) return null;
    const nameMatch = /^"([^"]+)"/.exec(replyTo);
    return nameMatch ? { address, name: nameMatch[1] } : { address };
}

/**
 * Build a base64url-encoded MIME message for Gmail API `users.messages.send`.
 */
export async function buildGmailRawMime(mailOptions, fromEmail) {
    const fromLine = mailOptions.from
        ? mailOptions.from.includes('<')
            ? mailOptions.from.replace(/<[^>]+>/, `<${fromEmail}>`)
            : `"${mailOptions.from}" <${fromEmail}>`
        : fromEmail;

    const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'windows',
    });

    const info = await transporter.sendMail({
        ...mailOptions,
        from: fromLine,
    });

    const getStreamBuffer = (stream) => new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });

    const mimeBuffer = await getStreamBuffer(info.message);

    return mimeBuffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
