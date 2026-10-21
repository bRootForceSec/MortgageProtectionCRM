import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Opens (and creates if needed) the database file with safe settings. */
export function openDatabase(file: string): DB {
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Every table in the database, by name (SQLite's own tables left out). */
export function tableNames(db: DB): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
}

/** Applies any migration files not yet recorded, in filename order, each in a transaction. */
export function migrate(db: DB, dir = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migration').all().map((r: any) => r.name as string),
  );
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)').run(
        f,
        new Date().toISOString(),
      );
    })();
    ran.push(f);
  }
  return ran;
}
