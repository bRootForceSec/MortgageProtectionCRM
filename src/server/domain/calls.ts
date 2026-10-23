import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { rebuildLeadState } from './leadState.js';
import { DomainError } from '../core/errors.js';
import { groupWhere, searchWhere } from './groupFilter.js';

export interface ManualCallInput {
  lead_id: string;
  idempotency_key: string;
  from_number_id?: string | null;
  to_e164?: string | null;
  /** When the call happened; defaults to now. */
  occurred_at?: string | null;
  talk_seconds?: number | null;
  /** Dials made for this one attempt (default 1). */
  dial_count?: number | null;
  /** Seconds the lead was on screen before you saved (Calling page). */
  lead_seconds?: number | null;
  outcome_code: string;
  callback_due_at?: string | null;
  /** The callback is for a day, any time that day; callback_due_at is the start of that day. */
  callback_any_time?: boolean | null;
  /** They asked not to be called again: the lead goes to the dead pile. */
  do_not_call?: boolean | null;
  note?: string | null;
}

interface OutcomeRow {
  code: string;
  requires_callback_time: number;
  active: number;
}

function getOutcome(db: DB, code: string): OutcomeRow {
  const o = db.prepare('SELECT code, requires_callback_time, active FROM outcome_code WHERE code = ?').get(code) as
    | OutcomeRow
    | undefined;
  if (!o) throw new DomainError(`unknown outcome "${code}"`);
  if (!o.active) throw new DomainError(`outcome "${code}" is retired`);
  return o;
}

function checkIso(v: string | null | undefined, what: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new DomainError(`${what} is not a valid date/time`);
  return new Date(t).toISOString();
}

/**
 * Records a call placed outside the app (e.g. on Sideline) together with its outcome.
 * Idempotent: the same idempotency_key returns the existing call instead of creating a second one.
 */
export function logManualCall(db: DB, input: ManualCallInput) {
  if (!input.idempotency_key || input.idempotency_key.length < 8) throw new DomainError('idempotency_key required');
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM call WHERE idempotency_key = ?').get(input.idempotency_key) as
      | { id: string }
      | undefined;
    if (existing) return { call_id: existing.id, duplicate: true };

    const lead = db.prepare('SELECT id, phone_e164 FROM lead WHERE id = ?').get(input.lead_id) as
      | { id: string; phone_e164: string | null }
      | undefined;
    if (!lead) throw new DomainError('lead not found', 404);
    // Unless you dialed another of the lead's numbers, the call went to the number the lead is being called on.
    const active = db.prepare('SELECT active_phone_e164 FROM lead_state WHERE lead_id = ?').get(lead.id) as { active_phone_e164: string | null } | undefined;
    const to = input.to_e164 || active?.active_phone_e164 || lead.phone_e164;
    if (!to) throw new DomainError('lead has no valid phone number');
    const outcome = getOutcome(db, input.outcome_code);
    const callbackDue = checkIso(input.callback_due_at, 'callback time');
    if (outcome.requires_callback_time && !callbackDue) throw new DomainError('a callback needs a date and time');

    let fromE164: string | null = null;
    if (input.from_number_id) {
      const n = db.prepare('SELECT e164, status FROM caller_number WHERE id = ?').get(input.from_number_id) as
        | { e164: string; status: string }
        | undefined;
      if (!n) throw new DomainError('caller ID number not found');
      if (n.status === 'retired') throw new DomainError('that caller ID number is retired');
      fromE164 = n.e164;
    }
    const now = nowIso();
    const at = checkIso(input.occurred_at, 'call time') ?? now;
    if (at > now) throw new DomainError('call time is in the future');
    const talk = input.talk_seconds == null ? null : Math.max(0, Math.round(input.talk_seconds));
    const dials = input.dial_count == null ? 1 : Math.round(input.dial_count);
    if (!(dials >= 1)) throw new DomainError('dial count must be at least 1');
    const onLead = input.lead_seconds == null ? null : Math.max(0, Math.round(input.lead_seconds));
    const callId = uuidv7();
    db.prepare(
      `INSERT INTO call (id, lead_id, direction, channel, from_number_id, from_e164, to_e164, requested_at, idempotency_key,
        initiation_result, state, state_confirmed_by, started_at, talk_seconds, dial_count, lead_seconds, derived_at)
       VALUES (?, ?, 'outbound', 'manual_log', ?, ?, ?, ?, ?, 'accepted', 'ended', 'manual', ?, ?, ?, ?, ?)`,
    ).run(callId, lead.id, input.from_number_id ?? null, fromE164, to, at, input.idempotency_key, at, talk, dials, onLead, now);
    db.prepare(
      `INSERT INTO call_event (id, call_id, source, dedup_key, event_type_raw, event_type, occurred_at, received_at, payload_json)
       VALUES (?, ?, 'manual', ?, 'manual.logged', 'call.logged_manually', ?, ?, ?)`,
    ).run(uuidv7(), callId, `manual:${callId}`, at, now, JSON.stringify({ talk_seconds: talk, dial_count: dials, from_e164: fromE164, to_e164: to }));
    db.prepare(
      `INSERT INTO call_outcome (id, call_id, outcome_code, entered_at, callback_due_at, callback_any_time, note, do_not_call)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(uuidv7(), callId, outcome.code, now, callbackDue, callbackDue && input.callback_any_time ? 1 : 0, input.note?.trim() || null, input.do_not_call ? 1 : 0);
    if (input.note?.trim()) {
      db.prepare('INSERT INTO note (id, lead_id, call_id, body, created_at) VALUES (?,?,?,?,?)').run(
        uuidv7(), lead.id, callId, input.note.trim(), now,
      );
    }
    rebuildLeadState(db, [lead.id]);
    return { call_id: callId, duplicate: false };
  })();
}

/**
 * Undoes a logged call. The call, its events and outcomes stay in history marked as undone; it stops counting
 * toward the lead's state and your numbers.
 * Returns what was entered so the screen can put it back for you to fix.
 */
export function voidCall(db: DB, callId: string, reason?: string | null) {
  return db.transaction(() => {
    const call = db.prepare('SELECT * FROM call WHERE id = ?').get(callId) as any;
    if (!call) throw new DomainError('call not found', 404);
    if (call.voided_at) throw new DomainError('this call was already undone', 409);
    if (call.channel !== 'manual_log') throw new DomainError('only calls you logged can be undone');
    const now = nowIso();
    db.prepare('UPDATE call SET voided_at = ?, void_reason = ? WHERE id = ?').run(now, reason?.trim() || 'undone', callId);
    db.prepare(
      `INSERT INTO call_event (id, call_id, source, dedup_key, event_type_raw, event_type, occurred_at, received_at, payload_json)
       VALUES (?, ?, 'manual', ?, 'manual.voided', 'call.voided', ?, ?, ?)`,
    ).run(uuidv7(), callId, `void:${callId}`, now, now, JSON.stringify({ reason: reason ?? null }));
    const out = currentOutcome(db, callId);
    const note = db.prepare('SELECT body FROM note WHERE call_id = ? ORDER BY created_at LIMIT 1').get(callId) as { body: string } | undefined;
    if (call.lead_id) rebuildLeadState(db, [call.lead_id]);
    return {
      lead_id: call.lead_id as string | null,
      outcome_code: out?.outcome_code ?? null,
      callback_due_at: out?.callback_due_at ?? null,
      callback_any_time: !!out?.callback_any_time,
      do_not_call: !!out?.do_not_call,
      dial_count: call.dial_count as number,
      talk_seconds: call.talk_seconds as number | null,
      lead_seconds: call.lead_seconds as number | null,
      from_number_id: call.from_number_id as string | null,
      note: note?.body ?? null,
    };
  })();
}

/** Current outcome of a call: the latest outcome that nothing supersedes. */
export function currentOutcome(db: DB, callId: string) {
  return db
    .prepare(
      `SELECT * FROM call_outcome o WHERE o.call_id = ?
       AND NOT EXISTS (SELECT 1 FROM call_outcome s WHERE s.supersedes_id = o.id)
       ORDER BY entered_at DESC LIMIT 1`,
    )
    .get(callId) as { id: string; outcome_code: string; callback_due_at: string | null; callback_any_time: number; do_not_call: number } | undefined;
}

/**
 * Changes a call's outcome by adding a superseding record. The old outcome and all call events stay.
 * `expected_current_id` guards against two edits racing (e.g. double submit).
 */
export function changeOutcome(
  db: DB,
  callId: string,
  input: {
    outcome_code: string; expected_current_id: string | null; callback_due_at?: string | null; callback_any_time?: boolean | null;
    /** Left out: keeps the call's current "Do not call" tick. */
    do_not_call?: boolean | null;
    note?: string | null;
  },
) {
  return db.transaction(() => {
    const call = db.prepare('SELECT id, lead_id, voided_at FROM call WHERE id = ?').get(callId) as
      | { id: string; lead_id: string; voided_at: string | null }
      | undefined;
    if (!call) throw new DomainError('call not found', 404);
    if (call.voided_at) throw new DomainError('this call was undone; log a new one instead', 409);
    const cur = currentOutcome(db, callId) ?? null;
    if ((cur?.id ?? null) !== (input.expected_current_id ?? null)) {
      throw new DomainError('outcome was changed elsewhere; reload and try again', 409);
    }
    const o = getOutcome(db, input.outcome_code);
    const due = checkIso(input.callback_due_at, 'callback time');
    if (o.requires_callback_time && !due) throw new DomainError('a callback needs a date and time');
    const id = uuidv7();
    db.prepare(
      `INSERT INTO call_outcome (id, call_id, outcome_code, entered_at, supersedes_id, callback_due_at, callback_any_time, note, do_not_call)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, callId, o.code, nowIso(), cur?.id ?? null, due, due && input.callback_any_time ? 1 : 0, input.note?.trim() || null,
      (input.do_not_call ?? !!cur?.do_not_call) ? 1 : 0,
    );
    if (call.lead_id) rebuildLeadState(db, [call.lead_id]);
    return { outcome_id: id };
  })();
}

export function addLeadAction(db: DB, leadId: string, action: 'skip' | 'mark_dead' | 'restore', reason?: string | null) {
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM lead WHERE id = ?').get(leadId)) throw new DomainError('lead not found', 404);
    const id = uuidv7();
    db.prepare('INSERT INTO lead_action (id, lead_id, action, reason, created_at) VALUES (?,?,?,?,?)').run(
      id, leadId, action, reason?.trim() || null, nowIso(),
    );
    rebuildLeadState(db, [leadId]);
    return { action_id: id };
  })();
}

export function addNote(db: DB, leadId: string, body: string, callId?: string | null) {
  const text = body?.trim();
  if (!text) throw new DomainError('note is empty');
  if (text.length > 10_000) throw new DomainError('note is too long');
  if (!db.prepare('SELECT 1 FROM lead WHERE id = ?').get(leadId)) throw new DomainError('lead not found', 404);
  const id = uuidv7();
  db.prepare('INSERT INTO note (id, lead_id, call_id, body, created_at) VALUES (?,?,?,?,?)').run(id, leadId, callId ?? null, text, nowIso());
  return { note_id: id };
}

/** Active outcome codes, in key order. */
export function activeOutcomeCodes(db: DB) {
  return db.prepare('SELECT * FROM outcome_code WHERE active = 1 ORDER BY sort_order').all();
}

/** Call history for the Calls page: newest first, at most 2000, filtered by dates, outcome, search and county groups. */
export function callHistory(
  db: DB,
  q: { from?: string; to?: string; outcome?: string; search?: string; counties?: string[]; areaCodes?: string[] },
) {
  const group = groupWhere('l.county_key', q);
  const search = searchWhere(q.search);
  const rows = db
    .prepare(
      `SELECT c.id, c.lead_id, c.channel, c.from_e164, c.to_e164, c.requested_at, c.state, c.talk_seconds, c.dial_count, c.lead_seconds, c.voided_at,
              c.time_known,
              trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) lead_name, l.county, n.label from_label,
              (SELECT o.outcome_code FROM call_outcome o WHERE o.call_id = c.id
                 AND NOT EXISTS (SELECT 1 FROM call_outcome x WHERE x.supersedes_id = o.id) ORDER BY o.entered_at DESC LIMIT 1) outcome_code
       FROM call c LEFT JOIN lead l ON l.id = c.lead_id LEFT JOIN caller_number n ON n.id = c.from_number_id
       WHERE (@from IS NULL OR c.requested_at >= @from) AND (@to IS NULL OR c.requested_at < @to)
         AND ${group.sql} AND ${search.sql}
       ORDER BY c.requested_at DESC LIMIT 2000`,
    )
    .all({ from: q.from ?? null, to: q.to ?? null, ...group.params, ...search.params }) as { outcome_code: string | null }[];
  return rows.filter((r) => !q.outcome || r.outcome_code === q.outcome);
}
