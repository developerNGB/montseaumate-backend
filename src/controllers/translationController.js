import pool from '../db/pool.js';

// GET /api/translations
export const getTranslations = async (req, res) => {
    try {
        const result = await pool.query('SELECT key_name, english_text, spanish_text FROM translations');
        // Convert to a simple key-value object for easy use in frontend
        const mapping = {};
        result.rows.forEach(row => {
            mapping[row.key_name] = row.spanish_text;
        });
        res.json({ success: true, translations: mapping, raw: result.rows });
    } catch (err) {
        console.error('[getTranslations]', err);
        res.status(500).json({ success: false, message: 'Failed to fetch translations' });
    }
};

// POST /api/translations/update
export const updateTranslation = async (req, res) => {
    try {
        const { key_name, english_text, spanish_text } = req.body;
        if (!key_name) return res.status(400).json({ success: false, message: 'Key name required' });

        await pool.query(
            `INSERT INTO translations (key_name, english_text, spanish_text, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (key_name) DO UPDATE SET
                english_text = EXCLUDED.english_text,
                spanish_text = EXCLUDED.spanish_text,
                updated_at = NOW()`,
            [key_name, english_text, spanish_text]
        );

        res.json({ success: true, message: 'Translation updated' });
    } catch (err) {
        console.error('[updateTranslation]', err);
        res.status(500).json({ success: false, message: 'Failed to update translation' });
    }
};
