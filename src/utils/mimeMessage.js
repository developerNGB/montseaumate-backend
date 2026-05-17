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
export function buildGmailRawMime(mailOptions, fromEmail) {
    const body = mailOptions.html || mailOptions.text || '';
    const contentType = mailOptions.html ? 'text/html' : 'text/plain';
    const fromLine = mailOptions.from
        ? mailOptions.from.includes('<')
            ? mailOptions.from.replace(/<[^>]+>/, `<${fromEmail}>`)
            : `"${mailOptions.from}" <${fromEmail}>`
        : fromEmail;

    const lines = ['MIME-Version: 1.0', `To: ${mailOptions.to}`, `From: ${fromLine}`];

    if (mailOptions.replyTo) lines.push(`Reply-To: ${mailOptions.replyTo}`);
    if (mailOptions.messageId) lines.push(`Message-ID: ${mailOptions.messageId}`);

    const extraHeaders = mailOptions.headers || {};
    for (const [key, value] of Object.entries(extraHeaders)) {
        if (value != null && value !== '') lines.push(`${key}: ${value}`);
    }

    lines.push(
        `Subject: =?utf-8?B?${Buffer.from(mailOptions.subject || '').toString('base64')}?=`,
        `Content-Type: ${contentType}; charset="UTF-8"`,
        'Content-Transfer-Encoding: 7bit',
        '',
        body,
    );

    return Buffer.from(lines.join('\r\n'))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
