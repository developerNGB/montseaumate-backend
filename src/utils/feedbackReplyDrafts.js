/**
 * Template-based "smart reply" drafts for customer feedback/reviews.
 * No external AI API required — picks a tone (thanks / neutral / apology) from
 * the rating, then tailors a sentence based on keywords found in the comment.
 */

const TOPIC_KEYWORDS = {
    service: {
        en: ['staff', 'service', 'team', 'employee', 'rude', 'friendly', 'helpful', 'attitude'],
        es: ['personal', 'servicio', 'equipo', 'empleado', 'grosero', 'amable', 'atencion', 'atención'],
    },
    speed: {
        en: ['slow', 'wait', 'waiting', 'delay', 'late', 'fast', 'quick', 'time'],
        es: ['lento', 'espera', 'esperar', 'retraso', 'tarde', 'rapido', 'rápido', 'tiempo'],
    },
    price: {
        en: ['price', 'expensive', 'cost', 'cheap', 'value', 'money', 'overpriced'],
        es: ['precio', 'caro', 'costo', 'barato', 'valor', 'dinero'],
    },
    quality: {
        en: ['quality', 'broken', 'defective', 'damaged', 'poor', 'excellent', 'great'],
        es: ['calidad', 'roto', 'defectuoso', 'dañado', 'pobre', 'excelente', 'genial'],
    },
    cleanliness: {
        en: ['dirty', 'clean', 'cleanliness', 'mess', 'hygiene'],
        es: ['sucio', 'limpio', 'limpieza', 'higiene'],
    },
    communication: {
        en: ['communication', 'response', 'reply', 'contact', 'call back', 'ignored'],
        es: ['comunicacion', 'comunicación', 'respuesta', 'responder', 'contacto', 'ignorado'],
    },
};

function detectTopics(comment, language) {
    if (!comment) return [];
    const text = comment.toLowerCase();
    const lang = language === 'es' ? 'es' : 'en';
    return Object.entries(TOPIC_KEYWORDS)
        .filter(([, kw]) => kw[lang].some((word) => text.includes(word)))
        .map(([topic]) => topic);
}

const TOPIC_LINES = {
    en: {
        service: "We're glad — or sorry, depending on your experience — about what you mentioned regarding our team's service.",
        speed: 'We hear you about the wait times, and that feedback helps us plan staffing better.',
        price: "We appreciate your feedback on pricing — we work hard to keep it fair for the value we provide.",
        quality: "Thank you for the feedback on quality — we take that seriously and will look into it.",
        cleanliness: 'Thanks for flagging cleanliness — that is something we take very seriously.',
        communication: "We're sorry if our communication didn't meet your expectations — we'll do better.",
    },
    es: {
        service: 'Gracias por tu comentario sobre la atención de nuestro equipo, lo tomamos en cuenta.',
        speed: 'Entendemos lo del tiempo de espera, esa información nos ayuda a mejorar.',
        price: 'Agradecemos tu opinión sobre el precio, trabajamos para mantenerlo justo.',
        quality: 'Gracias por tu comentario sobre la calidad, lo revisaremos con atención.',
        cleanliness: 'Gracias por mencionar la limpieza, es algo que tomamos muy en serio.',
        communication: 'Lamentamos si nuestra comunicación no fue la esperada, vamos a mejorar.',
    },
};

/**
 * @param {object} feedback - { rating_overall, comment, customer_name }
 * @param {object} opts - { language: 'en'|'es', companyName }
 * @returns {string} draft reply text
 */
export function generateFeedbackReplyDraft(feedback = {}, opts = {}) {
    const { rating_overall, comment, customer_name } = feedback;
    const language = opts.language === 'es' ? 'es' : 'en';
    const companyName = opts.companyName || (language === 'es' ? 'nuestro equipo' : 'our team');
    const name = customer_name?.trim() || (language === 'es' ? 'cliente' : 'there');
    const topics = detectTopics(comment, language);
    const topicLine = topics.length ? TOPIC_LINES[language][topics[0]] : '';

    const rating = Number(rating_overall) || 0;

    if (language === 'es') {
        if (rating >= 4) {
            return [
                `Hola ${name},`,
                '',
                `¡Muchas gracias por tu reseña y por tomarte el tiempo de compartirla! Nos alegra saber que tuviste una buena experiencia con ${companyName}.`,
                topicLine,
                'Esperamos verte de nuevo pronto.',
                '',
                'Saludos,',
                companyName,
            ].filter(Boolean).join('\n');
        }
        if (rating === 3) {
            return [
                `Hola ${name},`,
                '',
                'Gracias por tu sinceridad y por compartir tu experiencia con nosotros.',
                topicLine,
                'Nos encantaría saber más sobre cómo podemos mejorar — si tienes un momento, responde a este mensaje y con gusto te atendemos directamente.',
                '',
                'Saludos,',
                companyName,
            ].filter(Boolean).join('\n');
        }
        return [
            `Hola ${name},`,
            '',
            'Lamentamos mucho que tu experiencia no haya sido la que esperabas, y agradecemos que nos lo hayas hecho saber.',
            topicLine,
            'Nos gustaría hacerlo bien — por favor responde a este mensaje o llámanos para que podamos resolverlo directamente contigo.',
            '',
            'Saludos,',
            companyName,
        ].filter(Boolean).join('\n');
    }

    // English (default)
    if (rating >= 4) {
        return [
            `Hi ${name},`,
            '',
            `Thank you so much for your review and for taking the time to share it! We're thrilled to hear you had a great experience with ${companyName}.`,
            topicLine,
            'We hope to see you again soon.',
            '',
            'Best,',
            companyName,
        ].filter(Boolean).join('\n');
    }
    if (rating === 3) {
        return [
            `Hi ${name},`,
            '',
            'Thanks for your honest feedback — we really appreciate you sharing your experience.',
            topicLine,
            "We'd love to hear more about how we can improve. If you have a minute, just reply to this message and we'll personally follow up.",
            '',
            'Best,',
            companyName,
        ].filter(Boolean).join('\n');
    }
    return [
        `Hi ${name},`,
        '',
        "We're really sorry your experience wasn't what it should have been, and we appreciate you letting us know.",
        topicLine,
        "We'd like to make this right — please reply to this message or give us a call so we can sort this out with you directly.",
        '',
        'Best,',
        companyName,
    ].filter(Boolean).join('\n');
}
