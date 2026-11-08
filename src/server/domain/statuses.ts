import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { uuidv7 } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { conditionSql, loadStatusDefs } from './formulas.js';
import { STARTER_LISTS, Statuses, type Status, type StatusBadge, type StatusInfo } from '../../shared/statuses.js';

// Your statuses (shared/statuses.ts): named conditions, kept as the `statuses` setting. Nothing is stored per lead:
// which statuses a lead is in is worked out by SQLite from each condition whenever it's asked.

export { loadStatusDefs as loadStatuses };

/**
 * Once: the starter smart lists (the old fixed Leads tabs), after any you have, leaving out a name you already use.
 * Run when the database opens.
 */
export function addStarterLists(db: DB): boolean {
  if (getSetting<boolean>(db, 'starter_lists_done')) return false;
  const have = loadStatusDefs(db);
  const taken = new Set(have.map((st) => st.name.toLowerCase()));
  const add = STARTER_LISTS.filter((st) => !taken.has(st.name.toLowerCase())).map((st) => ({ id: uuidv7(), ...st }));
  setSetting(db, 'statuses', [...have, ...add]);
  setSetting(db, 'starter_lists_done', true);
  return true;
}

/** Each status's condition as SQL over `lead l JOIN lead_state s`, or null when it has a mistake. */
function statusSql(db: DB, statuses: readonly Status[]): (string | null)[] {
  return statuses.map((st) => {
    try {
      return conditionSql(db, st.condition, statuses, [`status:${st.name.toLowerCase()}`]);
    } catch {
      return null;
    }
  });
}

/** Your statuses in order, with how many leads are in each now (or what's wrong with its condition). */
export function listStatuses(db: DB): StatusInfo[] {
  const statuses = loadStatusDefs(db);
  return statuses.map((st) => {
    try {
      const sql = conditionSql(db, st.condition, statuses, [`status:${st.name.toLowerCase()}`]);
      const n = (db.prepare(`SELECT COUNT(*) n FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE ${sql}`).get() as { n: number }).n;
      return { ...st, leads: n, error: null };
    } catch (e) {
      return { ...st, leads: null, error: (e as Error).message };
    }
  });
}

/** Saves your statuses, in order. Every name is different, and every condition works (including status() in it). */
export function saveStatuses(db: DB, input: unknown): StatusInfo[] {
  let statuses = Statuses.parse(input);
  // A renamed status: other conditions that use status("Old name") follow it.
  for (const before of loadStatusDefs(db)) {
    const now = statuses.find((st) => st.id === before.id);
    if (now && now.name !== before.name) statuses = statuses.map((st) => ({ ...st, condition: renameStatusIn(st.condition, before.name, now.name) }));
  }
  const names = new Set<string>();
  for (const st of statuses) {
    const key = st.name.toLowerCase();
    if (names.has(key)) throw new DomainError(`two smart lists are called "${st.name}"`);
    names.add(key);
  }
  if (new Set(statuses.map((st) => st.id)).size !== statuses.length) throw new DomainError('two smart lists have the same id');
  for (const st of statuses) {
    try {
      conditionSql(db, st.condition, statuses, [`status:${st.name.toLowerCase()}`]);
    } catch (e) {
      throw new DomainError(`${st.name}: ${(e as Error).message}`);
    }
  }
  setSetting(db, 'statuses', statuses);
  return listStatuses(db);
}

/**
 * An SQL expression over `lead l JOIN lead_state s` giving, as a JSON array of 0/1, whether the lead is in each
 * status (same order as `statuses`), and a way to turn that into badges. Null when you have no statuses.
 */
export function statusFlags(db: DB): { sql: string; badges: (flags: string | null) => StatusBadge[] } | null {
  const statuses = loadStatusDefs(db);
  if (!statuses.length) return null;
  const sql = statusSql(db, statuses);
  return {
    sql: `json_array(${sql.map((x) => (x ? `CASE WHEN ${x} THEN 1 ELSE 0 END` : '0')).join(', ')})`,
    badges: (flags) => {
      const on = flags ? (JSON.parse(flags) as number[]) : [];
      return statuses.filter((_, i) => on[i] === 1).map((st) => ({ id: st.id, name: st.name, color: st.color }));
    },
  };
}

/** The statuses one lead is in, in your order. */
export function leadStatuses(db: DB, leadId: string): StatusBadge[] {
  const f = statusFlags(db);
  if (!f) return [];
  const r = db.prepare(`SELECT ${f.sql} flags FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE l.id = ?`).get(leadId) as { flags: string } | undefined;
  return f.badges(r?.flags ?? null);
}

/** A status's condition as SQL, for the Leads filter `in_status` (a status id). */
export function statusWhere(db: DB, id: string): string {
  const statuses = loadStatusDefs(db);
  const st = statuses.find((x) => x.id === id);
  if (!st) throw new DomainError('that status is gone', 404);
  try {
    return conditionSql(db, st.condition, statuses, [`status:${st.name.toLowerCase()}`]);
  } catch (e) {
    throw new DomainError(`${st.name}: ${(e as Error).message}`);
  }
}

/** The condition with status("Old") (any case, either quotes) using the new name. */
export function renameStatusIn(src: string, from: string, to: string): string {
  return src.replace(/\b(status|in_list)\(\s*(["'])(.*?)\2\s*\)/gi, (m, fn: string, q: string, name: string) => (name.trim().toLowerCase() === from.toLowerCase() ? `${fn}(${q}${to}${q})` : m));
}
