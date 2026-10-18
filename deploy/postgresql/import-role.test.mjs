import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginImportTransaction } from './import-role.mjs';

const fixture = (database = 'ferry_tracker', login = 'sd_ferry_tracker_migrator', activeRole = 'sd_ferry_tracker_owner') => {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.includes('session_user')) return { rows: [{ database, login }] };
      if (sql.includes('current_user')) return { rows: [{ role: activeRole }] };
      return { rows: [] };
    },
  };
};

test('import assumes owner only inside the migration transaction', async () => {
  const client = fixture();
  await beginImportTransaction(client);
  assert.deepEqual(client.calls, [
    'BEGIN',
    'SELECT current_database() AS database, session_user AS login',
    'SET LOCAL ROLE "sd_ferry_tracker_owner"',
    'SELECT current_user AS role',
  ]);
});

test('import refuses runtime and administrator logins before assuming any role', async () => {
  for (const login of ['postgres', 'sd_ferry_tracker_runtime', 'another_migrator']) {
    const client = fixture('ferry_tracker', login);
    await assert.rejects(beginImportTransaction(client), /dedicated migration login/);
    assert.equal(client.calls.length, 2);
  }
});

test('import rejects unsafe or overlong database names before forming SQL', async () => {
  for (const database of ['x"; SET ROLE postgres;--', 'a'.repeat(41), '', null]) {
    const client = fixture(database);
    await assert.rejects(beginImportTransaction(client), /role naming convention/);
    assert.equal(client.calls.length, 2);
  }
});

test('import fails when owner cannot be assumed or read-back differs', async () => {
  await assert.rejects(beginImportTransaction(fixture('ferry_tracker', 'sd_ferry_tracker_migrator', 'postgres')), /expected non-login owner/);
  const client = fixture();
  const query = client.query.bind(client);
  client.query = async sql => {
    if (sql.startsWith('SET LOCAL ROLE')) throw new Error('permission denied');
    return query(sql);
  };
  await assert.rejects(beginImportTransaction(client), /permission denied/);
});

test('import role convention also supports the disposable integration database', async () => {
  const client = fixture('sd_test_ferry', 'sd_sd_test_ferry_migrator', 'sd_sd_test_ferry_owner');
  await beginImportTransaction(client);
  assert.ok(client.calls.includes('SET LOCAL ROLE "sd_sd_test_ferry_owner"'));
});
