import type { DB } from '../db/connection.js';
import { nowIso } from '../ids.js';

// Settings are JSON values in the app_setting table, one row per key. Secrets never go here (see ai/settings.ts Secrets).

export function getSetting<T>(db: DB, key: string): T | null {
  const r = db.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(key) as { value_json: string } | undefined;
  return r ? (JSON.parse(r.value_json) as T) : null;
}

export function setSetting(db: DB, key: string, value: unknown) {
  db.prepare(
    `INSERT INTO app_setting (key, value_json, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowIso());
}
