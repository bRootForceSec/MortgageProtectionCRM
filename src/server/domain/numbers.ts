import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';
import { DomainError } from './calls.js';
import { CURRENT_RESULT_SQL } from './leadState.js';

// Caller ID numbers: how each one is doing, and the reputation checks you do by hand.
// Nothing here switches, buys or rotates numbers; that's always your call.

export const REPUTATION_CHECKS = [
  { item: 'free_caller_registry', label: 'Registered at the Free Caller Registry (freecallerregistry.com)' },
  { item: 'cnam', label: 'Caller name (CNAM) set with your phone provider' },
  { item: 'test_att', label: 'Test call to an AT&T phone shows no spam label' },
  { item: 'test_tmobile', label: 'Test call to a T-Mobile phone shows no spam label' },
  { item: 'test_verizon', label: 'Test call to a Verizon phone shows no spam label' },
  { item: 'lookup_apps', label: 'No spam reports on Hiya, Robokiller or Nomorobo' },
] as const;

const DAY = 86_400_000;

/** Calls, dials, contact rate and appointments for each number. `todayFrom` is the start of your day. */
export function numberStats(db: DB, todayFrom: string, now = new Date()) {
  const since7 = new Date(now.getTime() - 7 * DAY).toISOString();
  const since30 = new Date(now.getTime() - 30 * DAY).toISOString();
  const rows = db
    .prepare(
      `WITH c AS (
         SELECT c.from_number_id id, c.requested_at, c.dial_count, coalesce(oc.counts_as_human_contact, 0) h, o.outcome_code
         FROM call c
         LEFT JOIN call_outcome o ON o.call_id = c.id AND NOT EXISTS (SELECT 1 FROM call_outcome x WHERE x.supersedes_id = o.id)
         LEFT JOIN outcome_code oc ON oc.code = o.outcome_code
         WHERE c.from_number_id IS NOT NULL AND c.initiation_result = 'accepted' AND c.voided_at IS NULL AND c.time_known = 1)
       SELECT n.id,
         (SELECT count(*) FROM c WHERE c.id = n.id AND requested_at >= @today) calls_today,
         (SELECT coalesce(sum(dial_count), 0) FROM c WHERE c.id = n.id AND requested_at >= @today) dials_today,
         (SELECT count(*) FROM c WHERE c.id = n.id AND requested_at >= @d7) calls_7d,
         (SELECT coalesce(sum(dial_count), 0) FROM c WHERE c.id = n.id AND requested_at >= @d7) dials_7d,
         (SELECT count(*) FROM c WHERE c.id = n.id AND requested_at >= @d7 AND h = 1) contacts_7d,
         (SELECT count(*) FROM c WHERE c.id = n.id AND requested_at >= @d30) calls_30d,
         (SELECT coalesce(sum(dial_count), 0) FROM c WHERE c.id = n.id AND requested_at >= @d30) dials_30d,
         (SELECT count(*) FROM c WHERE c.id = n.id AND outcome_code = 'appointment') appointments,
         (SELECT count(*) FROM appointment a LEFT JOIN call sc ON sc.id = a.set_on_call_id
            WHERE a.set_from_number_id = n.id AND a.internal_status <> 'canceled' AND (sc.id IS NULL OR sc.voided_at IS NULL)
              AND (a.scheduled_for IS NULL OR a.scheduled_for >= @now) AND ${CURRENT_RESULT_SQL} IS NULL) open_appointments
       FROM caller_number n`,
    )
    .all({ today: todayFrom, d7: since7, d30: since30, now: now.toISOString() }) as Record<string, number | string>[];
  return rows.map((r) => ({ ...r, contact_rate_7d: Number(r.calls_7d) > 0 ? Number(r.contacts_7d) / Number(r.calls_7d) : null }));
}

/** The current state of each checklist item for a number, plus when it was last changed. */
export function numberChecks(db: DB, numberId: string) {
  const rows = db
    .prepare(
      `SELECT k.* FROM caller_number_check k WHERE k.number_id = ? AND k.id = (
         SELECT k2.id FROM caller_number_check k2 WHERE k2.number_id = k.number_id AND k2.item = k.item ORDER BY k2.created_at DESC, k2.id DESC LIMIT 1)`,
    )
    .all(numberId) as { item: string; checked_on: string | null; result: string | null; note: string | null; created_at: string }[];
  const by = new Map(rows.map((r) => [r.item, r]));
  return REPUTATION_CHECKS.map((c) => ({ ...c, checked_on: by.get(c.item)?.checked_on ?? null, result: by.get(c.item)?.result ?? null, note: by.get(c.item)?.note ?? null }));
}

export function recordNumberCheck(
  db: DB,
  numberId: string,
  input: { item: string; checked_on: string | null; result: 'ok' | 'problem' | null; note?: string | null },
) {
  if (!db.prepare('SELECT 1 FROM caller_number WHERE id = ?').get(numberId)) throw new DomainError('number not found', 404);
  if (!REPUTATION_CHECKS.some((c) => c.item === input.item)) throw new DomainError('unknown checklist item');
  if (input.checked_on && !/^\d{4}-\d{2}-\d{2}$/.test(input.checked_on)) throw new DomainError('enter the date as YYYY-MM-DD');
  db.prepare('INSERT INTO caller_number_check (id, number_id, item, checked_on, result, note, created_at) VALUES (?,?,?,?,?,?,?)').run(
    uuidv7(), numberId, input.item, input.checked_on, input.checked_on ? input.result ?? 'ok' : null, input.note?.trim() || null, nowIso(),
  );
  return numberChecks(db, numberId);
}
