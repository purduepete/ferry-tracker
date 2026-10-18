import { mkdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import Database from 'better-sqlite3';
import { latestVersion, migrations } from './schema.js';
import { applyViews } from './views.js';
import { openPostgres, type PostgresDatabase } from './postgres.js';

export type Db = Database.Database | PostgresDatabase;
export interface Stmt {
  all(...values: unknown[]): unknown[] | Promise<unknown[]>;
  get(...values: unknown[]): unknown | Promise<unknown>;
  run(...values: unknown[]): { changes: number } | Promise<{ changes: number }>;
}
const activeTransaction = new AsyncLocalStorage<Db>();
const queues = new WeakMap<Db, Promise<unknown>>();

export function transaction<T>(db: Db, work: () => Promise<T>): () => Promise<T> {
  if ('backend' in db) return db.transaction(work);
  return async () => {
    if (activeTransaction.getStore() === db) return work();
    const run = (queues.get(db) ?? Promise.resolve()).then(async () => {
      db.exec('BEGIN');
      try {
        const value = await activeTransaction.run(db, work);
        db.exec('COMMIT');
        return value;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    queues.set(db, run.catch(() => undefined));
    return run;
  };
}

export async function openConfiguredDatabase(filePath: string): Promise<Db> {
  const backend = process.env.STORAGE_BACKEND ?? 'sqlite';
  if (backend === 'postgresql') return openPostgres(process.env.DATABASE_URL);
  if (backend !== 'sqlite') throw new Error('Unsupported STORAGE_BACKEND.');
  return openDatabase(filePath);
}

export function requireLegacySqlite(): void {
  if (process.env.STORAGE_BACKEND === 'postgresql') {
    throw new Error('This SQLite-only command is disabled for PostgreSQL. Use reviewed PostgreSQL maintenance and framework backups.');
  }
}

export function openDatabase(filePath: string): Db {
  if (filePath !== ':memory:') mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  applyViews(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current >= latestVersion) return;

  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const apply = db.transaction(() => {
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      for (const statement of migration.statements) db.exec(statement);
      record.run(migration.version, new Date().toISOString());
    }
    // Mirrored into schema_migrations above because PRAGMA has no Azure SQL equivalent.
    db.pragma(`user_version = ${latestVersion}`);
  });
  apply();
}
