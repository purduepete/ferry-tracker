// Import is an explicit operator step, never application startup.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { sourceEntry, validateTransferProof } from './source-proof.mjs';
import { postgresConnection } from '../../server/dist/db/connection.js';

const tables = [
  'capture_run', 'vessel_observation', 'sailing_space_observation', 'sailing_space_departure',
  'sailing_leg', 'schedule_snapshot', 'vessel_reference', 'terminal_reference', 'archive_file', 'rollup_state', 'schema_migrations',
];
const keys = { vessel_reference: 'vessel_id', terminal_reference: 'terminal_id', rollup_state: 'name', schema_migrations: 'version' };
const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const sourceDir = argument('--source-dir');
const expected = argument('--expected-source-sha256');
const sourceIndex = argument('--source-index');
const expectedIndex = argument('--expected-index-sha256');
if (!sourceDir || !/^[a-f0-9]{64}$/i.test(expected ?? '')) throw new Error('Require --source-dir and --expected-source-sha256 for the reviewed, quiesced SQLite snapshot.');
if (!process.argv.includes('--execute')) throw new Error('Import requires --execute after independent review and production approval.');
if (!process.env.DATABASE_URL || !process.env.CAPTURE_ARCHIVE_DIR) throw new Error('Require DATABASE_URL and CAPTURE_ARCHIVE_DIR in private environment.');
if (!sourceIndex) throw new Error('Require --source-index pointing to the reviewed transfer.json.');
const proof = validateTransferProof(await readFile(sourceIndex), expectedIndex, 'ferry-tracker');
const entry = sourceEntry(proof, 'ferry-capture.db', ['sqlite']);
const sourceFile = path.resolve(sourceDir, ...entry.target.split('\\'));
for (const suffix of ['-wal', '-shm']) {
  try { await access(`${sourceFile}${suffix}`); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error('Snapshot has SQLite sidecars. Supply a reviewed coherent SQLite backup, not an active file copy.');
}
const hash = createHash('sha256');
let sourceBytes = 0;
for await (const bytes of createReadStream(sourceFile)) { hash.update(bytes); sourceBytes += bytes.length; }
const sourceSha = hash.digest('hex');
if (sourceSha !== expected.toLowerCase() || sourceSha !== entry.sha256 || sourceBytes !== entry.bytes) throw new Error('Source snapshot does not match reviewed SHA-256 and transfer.json.');
const connectionConfig = postgresConnection(process.env.DATABASE_URL);
const workParent = path.resolve('.run');
await mkdir(workParent, { recursive: true });
const workDirectory = await mkdtemp(path.join(workParent, 'ferry-import-'));
let source;
try {
  const workingFile = path.join(workDirectory, 'ferry-capture.db');
  await copyFile(sourceFile, workingFile);
  const workingHash = createHash('sha256');
  for await (const bytes of createReadStream(workingFile)) workingHash.update(bytes);
  if (workingHash.digest('hex') !== sourceSha) throw new Error('Working copy differs from the verified source snapshot.');
  source = new Database(workingFile, { readonly: true, fileMustExist: true });
  if (source.pragma('user_version', { simple: true }) !== 3) {
    throw new Error('Expected source SQLite schema version 3. Review a different source version explicitly.');
  }
} catch (error) {
  source?.close();
  await rm(workDirectory, { recursive: true, force: true });
  throw error;
}
const pool = new Pool({ ...connectionConfig, max: 1, connectionTimeoutMillis: 5000, options: '-c search_path=pg_catalog,public' });
let client;
const digestRow = (hash, columns, row) => hash.update(JSON.stringify(columns.map(column => row[column])) + '\n');
try {
  client = await pool.connect();
  await client.query('BEGIN');
  const ledger = await client.query('SELECT version FROM public.solutiondeploy_schema WHERE app_id=$1', ['ferry-tracker']);
  if (ledger.rows.length !== 1 || ledger.rows[0].version !== 1) throw new Error('Apply reviewed PostgreSQL schema version 1 before import.');
  const results = [];
  for (const table of tables) {
    const count = await client.query(`SELECT COUNT(*)::text AS count FROM public.${table}`);
    if (count.rows[0].count !== '0') throw new Error(`Destination ${table} is not empty. Import refuses overwrite or implicit resume.`);
  }
  for (const table of tables) {
    const columns = source.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
    if (!columns.length || columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error('Unexpected source column names.');
    const targetColumns = await client.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',
      ['public', table],
    );
    if (JSON.stringify(columns) !== JSON.stringify(targetColumns.rows.map(row => row.column_name))) {
      throw new Error(`Source/target column mapping differs for ${table}. Review schema drift before import.`);
    }
    const key = keys[table] ?? 'id';
    const sourceDigest = createHash('sha256');
    let count = 0;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const values = batch.flatMap(row => columns.map(column => row[column]));
      const placeholders = batch.map((_, row) =>
        `(${columns.map((_, column) => `$${row * columns.length + column + 1}`).join(',')})`);
      await client.query(`INSERT INTO public.${table} (${columns.map(c => `"${c}"`).join(',')}) VALUES ${placeholders.join(',')}`, values);
      batch = [];
    };
    for (const record of source.prepare(`SELECT * FROM "${table}" ORDER BY "${key}"`).iterate()) {
      const row = { ...record };
      if (table === 'archive_file') {
        const file = path.win32.basename(row.path);
        if (!file.endsWith('.ndjson.gz')) throw new Error('Unexpected archive filename.');
        row.path = path.join(process.env.CAPTURE_ARCHIVE_DIR, file);
        await access(row.path);
      }
      digestRow(sourceDigest, columns, row);
      batch.push(row);
      count++;
      if (batch.length === 500) await flush();
      if (count % 10000 === 0) console.log(`${table}: ${count} rows imported (${Math.round(process.uptime())}s elapsed)`);
    }
    await flush();
    const targetDigest = createHash('sha256');
    let after = null;
    let targetCount = 0;
    for (;;) {
      const result = await client.query(
        `SELECT * FROM public.${table} ${after === null ? '' : `WHERE "${key}" > $1`} ORDER BY "${key}" LIMIT 1000`,
        after === null ? [] : [after],
      );
      if (!result.rows.length) break;
      for (const row of result.rows) {
        for (const field of result.fields) {
          if ([20, 1700].includes(field.dataTypeID) && row[field.name] !== null) {
            const value = Number(row[field.name]);
            if (!Number.isSafeInteger(value)) throw new Error('Imported numeric identifier exceeds JavaScript precision.');
            row[field.name] = value;
          }
        }
        digestRow(targetDigest, columns, row);
        after = row[key];
        targetCount++;
      }
    }
    const sourceHash = sourceDigest.digest('hex');
    if (count !== targetCount || sourceHash !== targetDigest.digest('hex')) throw new Error(`Parity mismatch for ${table}; entire import will roll back.`);
    if (key === 'id') {
      await client.query(`SELECT setval(pg_get_serial_sequence('public.${table}','id'), COALESCE(MAX(id),1), COUNT(*)>0) FROM public.${table}`);
    }
    results.push({ table, count, sha256: sourceHash });
    console.log(`${table}: count and ordered row digest match (${count} rows)`);
  }
  await client.query('INSERT INTO public.solutiondeploy_import(app_id, source_sha256, validation) VALUES($1,$2,$3::jsonb)', ['ferry-tracker', sourceSha, JSON.stringify(results)]);
  await client.query('COMMIT');
  console.log('Ferry import committed; source retained. No application writer was started.');
} catch (error) {
  if (client) await client.query('ROLLBACK');
  console.error('Import rolled back. Keep target fenced; preserve this failure output. Do not automatically retry.');
  throw error;
} finally {
  client?.release();
  try { await pool.end(); }
  finally {
    try { source.close(); }
    finally { await rm(workDirectory, { recursive: true, force: true }); }
  }
}
