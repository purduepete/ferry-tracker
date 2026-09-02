import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { latestVersion, migrations } from './schema.js';

export type Db = Database.Database;
export type Stmt = Database.Statement<unknown[]>;

export function openDatabase(filePath: string): Db {
  if (filePath !== ':memory:') mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
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
