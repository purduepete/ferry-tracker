// Weekly backup task. VACUUM INTO does not modify the source, so the server keeps running.
// Only the SQLite database is copied. The raw gzip archive is large and refetchable from WSDOT.
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { getConfig } from '../server/dist/config.js';

const KEEP = Number(process.env.BACKUP_KEEP ?? 8);
if (process.env.STORAGE_BACKEND === 'postgresql')
    throw new Error('SQLite backup is disabled for PostgreSQL. Use the framework pg_dump backup.');

const { capture } = getConfig();
const dataDir = process.env.CAPTURE_DATA_DIR ?? path.dirname(capture.dbPath);
const backupDir = process.env.BACKUP_DIR ?? path.join(dataDir, 'backups');
mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(backupDir, `ferry-capture-${stamp}.db`);

const db = new Database(capture.dbPath);
try {
    db.pragma('busy_timeout = 30000');
    db.prepare('VACUUM INTO ?').run(target);
} finally {
    db.close();
}

console.log(
    `${new Date().toISOString()} backed up ${capture.dbPath} to ${target} (${Math.round(statSync(target).size / 1024)} KB)`
);

const stale = readdirSync(backupDir)
    .filter((name) => name.startsWith('ferry-capture-') && name.endsWith('.db'))
    .sort()
    .slice(0, -KEEP);
for (const name of stale) {
    unlinkSync(path.join(backupDir, name));
    console.log(`pruned ${name}`);
}
