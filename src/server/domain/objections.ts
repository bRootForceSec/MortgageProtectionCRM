import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { CURRENT_OUTCOME } from '../db/sql.js';
import { sqlCodes } from '../db/outcomeCodes.js';
import { groupWhere, type GroupFilter } from './groupFilter.js';

// Why a lead said no, per call: price, spouse, already covered and so on. The Calling screen offers them as chips after
// an outcome that asks for them (`objections` in src/shared/outcomes.ts). A call transcript can add its own later.

export interface ObjectionInput {
  code: string;
  note?: string | null;
}

/** Adds objections heard on a call. Call it inside the transaction that logs the call. */
export function recordObjections(db: DB, callId: string, items: ObjectionInput[], source: 'manual' | 'transcript' = 'manual', now = nowIso()) {
  if (!items.length) return;
  const known = db.prepare('SELECT 1 FROM objection_code WHERE code = ? AND active = 1');
  const insert = db.prepare('INSERT INTO call_objection (id, call_id, objection_code, note, source, created_at) VALUES (?,?,?,?,?,?)');
  for (const o of items) {
    if (!known.get(o.code)) throw new DomainError(`unknown objection "${o.code}"`);
    insert.run(uuidv7(), callId, o.code, o.note?.trim() || null, source, now);
  }
}

/**
 * How often each objection came up on calls made from `from` to `to` (not undone), most common first, in total and by
 * lead type (`by_type`, '' for leads with none). `calls` counts the calls that offered the chips (talked, sat, prezi),
 * so a share can be worked out. Optionally only some counties or area codes.
 */
export function objectionCounts(db: DB, from: string, to: string, groups: GroupFilter = {}) {
  const g = groupWhere('l.county_key', groups);
  const rows = db
    .prepare(
      `SELECT oc.code, oc.label, coalesce(l.lead_type, '') lead_type, COUNT(co.id) n
       FROM objection_code oc
       JOIN call_objection co ON co.objection_code = oc.code
       JOIN call c ON c.id = co.call_id JOIN lead l ON l.id = c.lead_id
       WHERE c.requested_at >= @from AND c.requested_at < @to AND c.voided_at IS NULL AND ${g.sql}
       GROUP BY oc.code, lead_type ORDER BY oc.sort_order`,
    )
    .all({ ...g.params, from, to }) as { code: string; label: string; lead_type: string; n: number }[];
  const byCode = new Map<string, { code: string; label: string; n: number; by_type: Record<string, number> }>();
  for (const r of rows) {
    const o = byCode.get(r.code) ?? { code: r.code, label: r.label, n: 0, by_type: {} };
    o.n += r.n;
    o.by_type[r.lead_type] = r.n;
    byCode.set(r.code, o);
  }
  // Stable: most common first, then the order they're offered in.
  return [...byCode.values()].sort((a, b) => b.n - a.n);
}

/** Calls from `from` to `to` (not undone) whose outcome offers objection chips, in total and by lead type. */
export function callsAskingObjections(db: DB, from: string, to: string, groups: GroupFilter = {}) {
  const g = groupWhere('l.county_key', groups);
  const rows = db
    .prepare(
      `SELECT coalesce(l.lead_type, '') lead_type, COUNT(*) n
       FROM call c JOIN lead l ON l.id = c.lead_id JOIN call_outcome o ON o.call_id = c.id AND ${CURRENT_OUTCOME}
       WHERE c.requested_at >= @from AND c.requested_at < @to AND c.voided_at IS NULL
         AND o.outcome_code IN ${sqlCodes((d) => d.objections)} AND ${g.sql}
       GROUP BY lead_type`,
    )
    .all({ ...g.params, from, to }) as { lead_type: string; n: number }[];
  return { n: rows.reduce((a, r) => a + r.n, 0), by_type: Object.fromEntries(rows.map((r) => [r.lead_type, r.n])) as Record<string, number> };
}

/** The objections offered on the Calling screen, in order. */
export function activeObjectionCodes(db: DB) {
  return db.prepare('SELECT code, label FROM objection_code WHERE active = 1 ORDER BY sort_order').all() as { code: string; label: string }[];
}

/** The objections you noted on a call, in the order you picked them. */
export function callObjections(db: DB, callId: string): string[] {
  return (db.prepare("SELECT objection_code FROM call_objection WHERE call_id = ? AND source = 'manual' ORDER BY created_at, rowid").all(callId) as { objection_code: string }[])
    .map((r) => r.objection_code);
}
