import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { DomainError } from '../core/errors.js';

// Why a lead said no, per call: price, spouse, already covered and so on. Nothing on screen asks for these yet. They
// are stored here so that a picker, and later a call transcript, have one place to put what they hear.

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

/** How often each objection came up on calls made from `from` to `to` (not undone), most common first. */
export function objectionCounts(db: DB, from: string, to: string) {
  return db
    .prepare(
      `SELECT oc.code, oc.label, COUNT(co.id) n
       FROM objection_code oc
       JOIN call_objection co ON co.objection_code = oc.code
       JOIN call c ON c.id = co.call_id
       WHERE c.requested_at >= ? AND c.requested_at < ? AND c.voided_at IS NULL
       GROUP BY oc.code ORDER BY n DESC, oc.sort_order`,
    )
    .all(from, to) as { code: string; label: string; n: number }[];
}
