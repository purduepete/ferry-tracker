export async function beginImportTransaction(client) {
    await client.query('BEGIN');
    const identity = await client.query('SELECT current_database() AS database, session_user AS login');
    const row = identity.rows[0];
    if (
        identity.rows.length !== 1 ||
        typeof row.database !== 'string' ||
        !/^[a-z][a-z0-9_]{1,39}$/.test(row.database)
    ) {
        throw new Error('Import requires a database with the reviewed role naming convention.');
    }
    const migrator = `sd_${row.database}_migrator`;
    const owner = `sd_${row.database}_owner`;
    if (row.login !== migrator) {
        throw new Error('Import requires the dedicated migration login, never the runtime or administrator login.');
    }
    await client.query(`SET LOCAL ROLE "${owner}"`);
    const active = await client.query('SELECT current_user AS role');
    if (active.rows.length !== 1 || active.rows[0].role !== owner) {
        throw new Error('Import did not assume the expected non-login owner role.');
    }
}
