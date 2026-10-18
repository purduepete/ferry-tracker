import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';

const connectionString = process.env.SOLUTIONDEPLOY_PG_TEST_URL;
if (!connectionString) throw new Error('SOLUTIONDEPLOY_PG_TEST_URL is required.');
const target = new URL(connectionString);
if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.search || decodeURIComponent(target.pathname) !== '/sd_test_ferry') throw new Error('Require disposable loopback sd_test_ferry.');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('imports an actual frozen synthetic SQLite snapshot with proof, preserves IDs, rejects tamper and replay', async () => {
  const root = path.resolve('.run', `pg-import-${process.pid}-${Date.now()}`);
  const data = path.join(root, 'backups', 'source');
  const pool = new Pool({ connectionString, max: 1 });
  const migrationUrl = new URL(connectionString);
  const owner = 'sd_sd_test_ferry_owner';
  const migrator = 'sd_sd_test_ferry_migrator';
  const migrationSecret = randomBytes(32).toString('hex');
  migrationUrl.username = migrator;
  migrationUrl.password = migrationSecret;
  try {
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe('sd_test_ferry');
    expect((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
    await pool.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await pool.query(`CREATE ROLE ${migrator} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${migrationSecret}'`);
    await pool.query(`GRANT ${owner} TO ${migrator}`);
    await pool.query(`GRANT CREATE ON DATABASE sd_test_ferry TO ${owner}`);
    await pool.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${owner}`);
    await pool.query(`SET ROLE ${owner}`);
    try { await pool.query(await readFile(path.resolve('deploy', 'postgresql', '001_initial.sql'), 'utf8')); }
    finally { await pool.query('RESET ROLE'); }
    await mkdir(data, { recursive: true });
    const sourceFile = path.join(data, 'ferry-capture.db');
    const source = openDatabase(sourceFile);
    try {
      await source.prepare('INSERT INTO capture_run(id,task,started_at,outcome) VALUES(?,?,?,?)')
        .run(41, 'synthetic-import', '2026-09-01T18:00:00.000Z', 'success');
      await source.prepare('INSERT INTO terminal_reference(terminal_id,terminal_name,updated_at) VALUES(?,?,?)')
        .run(7, 'Synthetic Seattle', '2026-09-01T18:00:00.000Z');
    } finally { await source.close(); }
    const bytes = await readFile(sourceFile);
    const proof = Buffer.from(JSON.stringify({
      planHash: 'a'.repeat(64), operationId: 'synthetic-import', sourceHost: 'jimbrownhome',
      stateDeclarationSHA256: 'b'.repeat(64), fence: { stopped: true }, directories: [],
      files: [{ target: 'backups\\source\\ferry-capture.db', kind: 'sqlite', bytes: bytes.length, sha256: sha(bytes), snapshot: { synthetic: true } }],
    }));
    const index = path.join(root, 'transfer.json');
    await writeFile(index, proof);
    const frozenInventory = async (): Promise<Array<{ path: string; sha256: string }>> => {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      const inventory = [];
      for (const entry of entries) {
        const filename = path.join(entry.parentPath, entry.name);
        inventory.push({
          path: path.relative(root, filename),
          sha256: entry.isDirectory() ? 'directory' : sha(await readFile(filename)),
        });
      }
      return inventory.sort((left, right) => left.path.localeCompare(right.path));
    };
    const originalInventory = await frozenInventory();
    const run = (indexHash: string, sourceHash = sha(bytes), databaseUrl = migrationUrl.toString()) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        'deploy\\postgresql\\import.mjs', '--source-dir', root, '--source-index', index,
        '--expected-index-sha256', indexHash, '--expected-source-sha256', sourceHash, '--execute',
      ], { env: { ...process.env, DATABASE_URL: databaseUrl, CAPTURE_ARCHIVE_DIR: path.join(root, 'raw') }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
      let output = '';
      child.stdout.on('data', bytes => { output += bytes.toString(); });
      child.stderr.on('data', bytes => { output += bytes.toString(); });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    expect((await run('0'.repeat(64))).code).not.toBe(0);
    expect((await run(sha(proof), '0'.repeat(64))).code).not.toBe(0);
    const administrator = await run(sha(proof), sha(bytes), connectionString);
    expect(administrator.code).not.toBe(0);
    expect(administrator.output).toContain('dedicated migration login');
    expect((await pool.query('SELECT count(*)::int AS n FROM public.capture_run')).rows[0].n).toBe(0);
    const imported = await run(sha(proof));
    expect(imported.output).toContain('Ferry import committed');
    expect(imported.code).toBe(0);
    expect(await frozenInventory()).toEqual(originalInventory);
    expect((await pool.query('SELECT id,task FROM public.capture_run')).rows).toEqual([{ id: '41', task: 'synthetic-import' }]);
    expect((await pool.query('SELECT terminal_name FROM public.terminal_reference WHERE terminal_id=7')).rows[0].terminal_name).toBe('Synthetic Seattle');
    expect((await pool.query('SELECT count(*)::int AS n FROM public.schema_migrations')).rows[0].n).toBe(3);
    const replay = await run(sha(proof));
    expect(replay.code).not.toBe(0);
    expect(replay.output).toContain('not empty');
    expect(await frozenInventory()).toEqual(originalInventory);
    expect((await pool.query('SELECT count(*)::int AS n FROM public.capture_run')).rows[0].n).toBe(1);
    expect((await pool.query("INSERT INTO public.capture_run(task,started_at,outcome) VALUES('sequence-probe','2026-09-01','success') RETURNING id")).rows[0].id).toBe('42');
    expect((await pool.query("SELECT source_sha256 FROM public.solutiondeploy_import WHERE app_id='ferry-tracker'")).rows[0].source_sha256).toBe(sha(bytes));
  } finally { await pool.end(); await rm(root, { recursive: true, force: true }); }
});
