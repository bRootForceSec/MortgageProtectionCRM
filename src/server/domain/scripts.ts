import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';
import { loadCallingSettings } from './callingSettings.js';

// Which opener was on screen for a call. Each distinct opener text is kept once as a version.

/** The version id of the opener in Settings now, adding it the first time it's used. Null when there is no opener. */
export function currentOpenerVersion(db: DB, now = nowIso()): string | null {
  const body = loadCallingSettings(db).scripts.opener.trim();
  if (!body) return null;
  db.prepare("INSERT INTO script_version (id, kind, body, created_at) VALUES (?, 'opener', ?, ?) ON CONFLICT(kind, body) DO NOTHING").run(uuidv7(), body, now);
  return (db.prepare("SELECT id FROM script_version WHERE kind = 'opener' AND body = ?").get(body) as { id: string }).id;
}
