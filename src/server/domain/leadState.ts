import type { DB } from '../db/connection.js';
import { nowIso } from '../ids.js';

// lead_state is a derived projection. It is computed only from authoritative facts:
// calls, current outcomes, lead actions (skip / dead / restore) and appointments.
// `rebuildLeadState` can be run at any time and must produce the same result.

export type LeadStatus = 'new' | 'retry' | 'callback' | 'appointment_set' | 'invalid' | 'dead' | 'sold';

export const RETRY_GAP_MS = 4 * 60 * 60 * 1000;

export interface LeadFacts {
  calls: { id: string; requested_at: string; from_number_id: string | null; initiation_result: string; time_known?: number }[];
  /** Current (non-superseded) outcome per call. */
  outcomes: {
    call_id: string;
    entered_at: string;
    outcome_code: string;
    grp: string;
    marks_dead: number;
    counts_as_human_contact: number;
    callback_due_at: string | null;
    lead_effect?: string | null;
  }[];
  actions: { action: 'skip' | 'mark_dead' | 'restore'; created_at: string }[];
  appointments: {
    scheduled_for: string | null;
    internal_status: string;
    set_from_number_id: string | null;
    created_at: string;
    official_status?: string | null;
  }[];
}

export interface DerivedLeadState {
  status: LeadStatus;
  attempts_total: number;
  last_call_at: string | null;
  last_outcome_code: string | null;
  next_due_at: string | null;
  skipped_at: string | null;
  preferred_number_id: string | null;
}

/** Pure function: facts in, state out. */
export function deriveLeadState(f: LeadFacts, now: string): DerivedLeadState {
  const placed = f.calls.filter((c) => c.initiation_result === 'accepted').sort(byKey('requested_at'));
  const lastCall = placed.at(-1) ?? null;
  const callTime = new Map(placed.map((c) => [c.id, c.requested_at]));
  // Order outcomes by the time of their call, then by entry time.
  const outcomes = [...f.outcomes].sort((a, b) =>
    (callTime.get(a.call_id) ?? '').localeCompare(callTime.get(b.call_id) ?? '') || a.entered_at.localeCompare(b.entered_at),
  );
  const lastOutcome = outcomes.at(-1) ?? null;
  const actions = [...f.actions].sort(byKey('created_at'));
  const lastRestore = actions.filter((a) => a.action === 'restore').at(-1)?.created_at ?? '';
  const skippedAt = actions.filter((a) => a.action === 'skip').at(-1)?.created_at ?? null;

  const deadAt = [
    ...actions.filter((a) => a.action === 'mark_dead').map((a) => a.created_at),
    ...outcomes.filter((o) => o.marks_dead).map((o) => o.entered_at),
  ].sort().at(-1);

  const soldAt = outcomes.filter((o) => o.lead_effect === 'sold').map((o) => o.entered_at).sort().at(-1);

  const appts = [...f.appointments].sort(byKey('created_at'));
  const live = appts.filter((a) => a.internal_status !== 'canceled' && !a.official_status);
  const openAppt = live.filter((a) => a.scheduled_for !== null && a.scheduled_for >= now).at(-1);
  // An appointment from a spreadsheet has no date: it stays open ("needs a date") until a later call says otherwise.
  const undatedAppt = lastOutcome?.outcome_code === 'appointment' ? live.filter((a) => a.scheduled_for === null).at(-1) : undefined;
  // Calls from a spreadsheet have no real time, so they don't start the retry gap.
  const timedCalls = placed.filter((c) => c.time_known !== 0);
  const preferred =
    appts.at(-1)?.set_from_number_id ??
    [...placed].reverse().find((c) => outcomes.some((o) => o.call_id === c.id && o.counts_as_human_contact))?.from_number_id ??
    null;

  const base = {
    attempts_total: placed.length,
    last_call_at: lastCall?.requested_at ?? null,
    last_outcome_code: lastOutcome?.outcome_code ?? null,
    skipped_at: skippedAt,
    preferred_number_id: preferred,
  };

  if (deadAt && deadAt > lastRestore) return { ...base, status: 'dead', next_due_at: null };
  if (lastOutcome?.grp === 'invalid' && lastOutcome.entered_at > lastRestore) {
    return { ...base, status: 'invalid', next_due_at: null };
  }
  if (soldAt && soldAt > lastRestore) return { ...base, status: 'sold', next_due_at: null };
  if (openAppt) return { ...base, status: 'appointment_set', next_due_at: openAppt.scheduled_for };
  if (undatedAppt) return { ...base, status: 'appointment_set', next_due_at: null };
  // A callback without a time (e.g. "reschedule" in a spreadsheet) is due now and listed as "needs a time".
  if (lastOutcome?.outcome_code === 'callback') {
    return { ...base, status: 'callback', next_due_at: lastOutcome.callback_due_at ?? null };
  }
  if (!lastCall) return { ...base, status: 'new', next_due_at: null };
  const lastTimed = timedCalls.at(-1);
  const due = lastTimed ? new Date(Date.parse(lastTimed.requested_at) + RETRY_GAP_MS).toISOString() : null;
  return { ...base, status: 'retry', next_due_at: due };
}

function byKey<K extends string>(k: K) {
  return (a: Record<K, string | null>, b: Record<K, string | null>) => (a[k] ?? '').localeCompare(b[k] ?? '');
}

export function loadLeadFacts(db: DB, leadId: string): LeadFacts {
  return {
    calls: db
      .prepare('SELECT id, requested_at, from_number_id, initiation_result, time_known FROM call WHERE lead_id = ?')
      .all(leadId) as LeadFacts['calls'],
    outcomes: db
      .prepare(
        `SELECT o.call_id, o.entered_at, o.outcome_code, c.grp, c.marks_dead, c.counts_as_human_contact, o.callback_due_at, c.lead_effect
         FROM call_outcome o
         JOIN call ON call.id = o.call_id
         JOIN outcome_code c ON c.code = o.outcome_code
         WHERE call.lead_id = ? AND NOT EXISTS (SELECT 1 FROM call_outcome s WHERE s.supersedes_id = o.id)`,
      )
      .all(leadId) as LeadFacts['outcomes'],
    actions: db.prepare('SELECT action, created_at FROM lead_action WHERE lead_id = ?').all(leadId) as LeadFacts['actions'],
    appointments: db
      .prepare('SELECT scheduled_for, internal_status, set_from_number_id, created_at, official_status FROM appointment WHERE lead_id = ?')
      .all(leadId) as LeadFacts['appointments'],
  };
}

const UPSERT = `INSERT INTO lead_state (lead_id, status, attempts_total, last_call_at, last_outcome_code, next_due_at,
    skipped_at, preferred_number_id, derived_at)
  VALUES (@lead_id, @status, @attempts_total, @last_call_at, @last_outcome_code, @next_due_at, @skipped_at,
    @preferred_number_id, @derived_at)
  ON CONFLICT(lead_id) DO UPDATE SET status = excluded.status, attempts_total = excluded.attempts_total,
    last_call_at = excluded.last_call_at, last_outcome_code = excluded.last_outcome_code, next_due_at = excluded.next_due_at,
    skipped_at = excluded.skipped_at, preferred_number_id = excluded.preferred_number_id, derived_at = excluded.derived_at`;

/** Recomputes lead_state for the given leads (all leads when omitted). */
export function rebuildLeadState(db: DB, leadIds?: string[], now = nowIso()): number {
  const ids = leadIds ?? (db.prepare('SELECT id FROM lead').all() as { id: string }[]).map((r) => r.id);
  const up = db.prepare(UPSERT);
  db.transaction(() => {
    for (const id of ids) up.run({ lead_id: id, ...deriveLeadState(loadLeadFacts(db, id), now), derived_at: now });
  })();
  return ids.length;
}

/** Compares stored lead_state with a fresh derivation. Returns lead ids that differ. */
export function verifyLeadState(db: DB, now = nowIso()): string[] {
  const rows = db.prepare('SELECT * FROM lead_state').all() as (DerivedLeadState & { lead_id: string })[];
  const keys: (keyof DerivedLeadState)[] = ['attempts_total', 'last_call_at', 'last_outcome_code', 'skipped_at', 'preferred_number_id'];
  const bad: string[] = [];
  for (const r of rows) {
    const d = deriveLeadState(loadLeadFacts(db, r.lead_id), now);
    // Status/next_due depend on "now" for appointments and retries, so compare the time-independent fields
    // plus status for leads whose status cannot change with time.
    const timeless = ['dead', 'invalid', 'new', 'callback', 'sold'].includes(d.status);
    if (keys.some((k) => d[k] !== r[k]) || (timeless && d.status !== r.status)) bad.push(r.lead_id);
  }
  const missing = db.prepare('SELECT id FROM lead WHERE id NOT IN (SELECT lead_id FROM lead_state)').all() as { id: string }[];
  return [...bad, ...missing.map((m) => m.id)];
}
