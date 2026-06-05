import pool from './src/db/pool.js';

(async () => {
    try {
        const usersRes = await pool.query('SELECT id, name, email, company_name FROM users');
        console.log('Users in database:');
        console.table(usersRes.rows);

        const integrationsRes = await pool.query(
            `SELECT i.user_id, u.email as user_email, i.provider, i.account_id, (i.refresh_token IS NOT NULL) as has_refresh_token, i.metadata 
             FROM integrations i 
             JOIN users u ON i.user_id = u.id`
        );
        console.log('Integrations in database:');
        console.table(integrationsRes.rows);
    } catch (err) {
        console.error('Database query failed:', err);
    } finally {
        await pool.end();
    }
})();
