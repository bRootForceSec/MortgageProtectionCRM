import type { Statement } from 'better-sqlite3';
import type { DB } from '../db/connection.js';
import { LEAD_NAME, CURRENT_OUTCOME } from '../db/sql.js';
import { nowIso } from '../ids.js';
import { followUpPlans, retryGapMs } from './callingSettings.js';
import { afterStep, type FollowUpPlans, type FollowUpResult } from '../../shared/followUps.js';
import { MISSED_RESULTS, isApptResult, type ApptResult } from '../../shared/appointments.js';
import { LEAD_STATUSES, type LeadStatus } from '../../shared/leadStatus.js';
import { BOOKED_CODES, outcomeDef } from '../../shared/outcomes.js';

// lead_state is a derived projection. It is computed only from authoritative facts:
// calls, current outcomes and lead actions (skip / dead / restore).
// `rebuildLeadState` can be run at any time and must produce the same result.
//
// Appointments are tracked in Unitrust. "Appointment set" is how a call ended: the lead leaves the queue. The Firefox
// extension reads how each appointment went off the Unitrust calendar (see unitrustAppointments.ts); when that is newer
// than the last call, it decides: booked, rescheduled or sold stays out of the queue; a no-show or a sat-no-sale comes back to be called.
// An appointment call logged here (the Appointment side of the Calling screen) decides the same way, and it wins over
// the Unitrust color of that appointment: Unitrust has no color for a prezi.

export type { LeadStatus };

/** Default gap before an unanswered lead comes back. You can change it in Settings. */
export const RETRY_GAP_MS = 4 * 60 * 60 * 1000;

/** Stands for the lead's main number when the facts don't list its numbers. */
const MAIN = '(main)';

export interface LeadFacts {
  calls: { id: string; requested_at: string; from_number_id: string | null; initiation_result: string; time_known?: number; to_e164?: string | null }[];
  /** Current (non-superseded) outcome per call. */
  outcomes: {
    call_id: string;
    entered_at: string;
    outcome_code: string;
    grp: string;
    marks_dead: number;
    counts_as_human_contact: number;
    callback_due_at: string | null;
    callback_any_time?: number;
    /** Ticked "Do not call": the lead goes to the dead pile. */
    do_not_call?: number;
  }[];
  actions: { action: 'skip' | 'mark_dead' | 'restore'; created_at: string }[];
  /** The lead's numbers in order: main, alternate, called-in-from. Left out in some tests: then only the main number counts. */
  phones?: string[];
  /** Numbers ruled out on other leads that share them: marked bad there, or that lead is in the dead pile. */
  blocks?: PhoneBlock[];
  /** How the lead's latest Unitrust appointment stands, and since when. */
  appt?: { result: ApptResult; at: string; /** The appointment's day, YYYY-MM-DD. */ day?: string } | null;
}

export interface PhoneBlock {
  phone: string;
  at: string;
  kind: 'bad' | 'dead';
  /** The other lead's name, for the reason shown on this one. */
  who: string;
}

export interface DerivedLeadState {
  status: LeadStatus;
  attempts_total: number;
  last_call_at: string | null;
  last_outcome_code: string | null;
  next_due_at: string | null;
  /** A callback for a day with no set time: next_due_at is the start of that day. */
  due_any_time: number;
  skipped_at: string | null;
  preferred_number_id: string | null;
  /** The number to call: the first of the lead's numbers that isn't ruled out. */
  active_phone_e164: string | null;
  /** Numbers on this lead that are ruled out (JSON list). */
  blocked_phones_json: string | null;
  /** Why a number is ruled out, when another lead ruled it out or the main number is bad. */
  block_reason: string | null;
  /** How the latest appointment went (logged here, or read from Unitrust), if there is one. */
  appt_result: ApptResult | null;
  /** 1 when a no-show, sat-no-sale or prezi (logged here, or in Unitrust after the last call) put the lead back to be called. */
  appt_missed: number;
}

/** Pure function: facts in, state out. */
export function deriveLeadState(f: LeadFacts, now: string, retryGap = RETRY_GAP_MS, followUps: FollowUpPlans = {}): DerivedLeadState {
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
    ...outcomes.filter((o) => o.marks_dead || o.do_not_call).map((o) => o.entered_at),
  ].sort().at(-1);

  // Calls from a spreadsheet have no real time, so they don't start the retry gap.
  const timedCalls = placed.filter((c) => c.time_known !== 0);
  // The number the lead knows you by: the one you booked them from, else the last one that reached them.
  const bookedCall = [...placed].reverse().find((c) => outcomes.some((o) => o.call_id === c.id && BOOKED_CODES.has(o.outcome_code)));
  const preferred =
    bookedCall?.from_number_id ??
    [...placed].reverse().find((c) => outcomes.some((o) => o.call_id === c.id && o.counts_as_human_contact))?.from_number_id ??
    null;

  // The latest appointment call logged here. It beats Unitrust's color for that appointment (on or after its day).
  const inApp = [...outcomes].reverse().find((o) => outcomeDef(o.outcome_code)?.apptResult) ?? null;
  const inAppResult = outcomeDef(inApp?.outcome_code)?.apptResult ?? null;
  const inAppDay = inApp ? (callTime.get(inApp.call_id) ?? inApp.entered_at).slice(0, 10) : '';
  const overridden = !!inApp && !!f.appt && inAppDay >= (f.appt.day ?? '');
  // An appointment booked again (on a first call) after the last appointment result: that result is old news.
  const rebooked = !!inApp && outcomes.slice(outcomes.indexOf(inApp) + 1).some((o) => BOOKED_CODES.has(o.outcome_code));
  const apptResult: ApptResult | null = inAppResult && (!f.appt || overridden) ? (rebooked ? 'not_set' : inAppResult) : f.appt?.result ?? null;

  const base = {
    attempts_total: placed.length,
    last_call_at: lastCall?.requested_at ?? null,
    last_outcome_code: lastOutcome?.outcome_code ?? null,
    skipped_at: skippedAt,
    preferred_number_id: preferred,
    due_any_time: 0,
    appt_result: apptResult,
    appt_missed: 0,
  };
  // Unitrust's word counts only when it came after the last outcome (and after a restore), and you haven't logged
  // how that appointment went here.
  const unitrust = f.appt && !overridden && f.appt.at > (lastOutcome?.entered_at ?? '') && f.appt.at > lastRestore ? f.appt : null;
  // Otherwise the last call decides, and it may be an appointment call.
  const lastAppt = !unitrust && lastOutcome && lastOutcome.entered_at > lastRestore ? outcomeDef(lastOutcome.outcome_code)?.apptResult ?? null : null;
  const missed = unitrust ? MISSED_RESULTS.includes(unitrust.result) : !!lastAppt && MISSED_RESULTS.includes(lastAppt);
  // The latest missed result still standing (the one a follow-up plan runs from), from Unitrust or a call logged here.
  const fromUnitrust = f.appt && !overridden && f.appt.at > lastRestore && MISSED_RESULTS.includes(f.appt.result) ? { result: f.appt.result, at: f.appt.at } : null;
  const fromApp = inApp && !rebooked && inAppResult && MISSED_RESULTS.includes(inAppResult) && inApp.entered_at > lastRestore ? { result: inAppResult, at: inApp.entered_at } : null;
  const missedResult = fromUnitrust && (!fromApp || fromUnitrust.at > fromApp.at) ? fromUnitrust : fromApp;

  // Which numbers are ruled out. A bad number counts for the number that was dialed, so a lead with an alternate
  // stays in rotation on the alternate. Other leads with the same number pass on "bad" and "dead pile".
  const realPhones = f.phones ?? [];
  const phones = realPhones.length ? realPhones : [MAIN];
  const calledNumber = new Map(placed.map((c) => [c.id, realPhones.length ? c.to_e164 ?? phones[0]! : MAIN]));
  const blocked = new Map<string, { kind: 'bad' | 'dead'; who: string | null }>();
  for (const o of outcomes) {
    const n = calledNumber.get(o.call_id);
    if (o.grp === 'invalid' && o.entered_at > lastRestore && n) blocked.set(n, { kind: 'bad', who: null });
  }
  for (const b of f.blocks ?? []) {
    if (b.at > lastRestore && phones.includes(b.phone) && blocked.get(b.phone)?.kind !== 'dead') blocked.set(b.phone, { kind: b.kind, who: b.who });
  }
  const active = phones.find((p) => !blocked.has(p)) ?? null;
  const ruledOut = phones.filter((p) => blocked.has(p) && p !== MAIN);
  const reasonFor = (p: string) => {
    const b = blocked.get(p)!;
    if (b.kind === 'dead') return `Same number as ${b.who}, who is in the dead pile`;
    return b.who ? `Same number as ${b.who}, marked as a bad number` : null;
  };
  const firstBlocked = phones.find((p) => blocked.has(p));
  let blockReason = firstBlocked ? reasonFor(firstBlocked) : null;
  if (active && firstBlocked && realPhones.length) blockReason = `${blockReason ?? 'The main number is a bad number'}; calling the other number`;
  const withPhones = {
    ...base,
    active_phone_e164: realPhones.length ? active : null,
    blocked_phones_json: ruledOut.length ? JSON.stringify(ruledOut) : null,
    block_reason: blockReason,
  };

  if (deadAt && deadAt > lastRestore) return { ...withPhones, status: 'dead', next_due_at: null, block_reason: null };
  // Booked: out of the queue until a later call (or Unitrust) says otherwise, or you restore it.
  const booked = unitrust
    ? !missed
    : lastAppt ? !missed : !!lastOutcome && BOOKED_CODES.has(lastOutcome.outcome_code) && lastOutcome.entered_at > lastRestore;
  if (booked) {
    return { ...withPhones, status: 'appointment_set', next_due_at: null };
  }
  if (!active) {
    // Every number is ruled out. One that belongs to someone in the dead pile puts this lead there too.
    const dead = phones.some((p) => blocked.get(p)?.kind === 'dead');
    return { ...withPhones, status: dead ? 'dead' : 'invalid', next_due_at: null };
  }
  // A no-show, sat-no-sale or prezi (here or in Unitrust) with a follow-up plan: each step is a callback, timed from
  // the result or the last unanswered try. Any other outcome since then (an answer, a callback, a bad number) ends it.
  const missedAt = missedResult ? missedResult.at : null;
  if (missedResult && missedAt) {
    const since = outcomes.filter((o) => o.entered_at > missedAt);
    const quiet = since.every((o) => !o.counts_as_human_contact && o.grp !== 'invalid' && !outcomeDef(o.outcome_code)?.callback
      && !outcomeDef(o.outcome_code)?.apptResult && !BOOKED_CODES.has(o.outcome_code));
    const step = quiet ? followUps[missedResult.result as FollowUpResult]?.[since.length] : undefined;
    if (step) {
      const from = since.length ? (callTime.get(since.at(-1)!.call_id) ?? since.at(-1)!.entered_at) : missedAt;
      return { ...withPhones, status: 'callback', next_due_at: afterStep(from, step), appt_missed: missed ? 1 : 0 };
    }
  }
  // Without a plan (or once it has run out): due now, to set it up again.
  if (missed) return { ...withPhones, status: 'retry', next_due_at: null, appt_missed: 1 };
  // The last call found a bad number but there's another one to try: due now, on the other number.
  if (lastOutcome?.grp === 'invalid' && lastOutcome.entered_at > lastRestore) {
    return { ...withPhones, status: 'retry', next_due_at: null };
  }
  // A callback without a time (e.g. "reschedule" in a spreadsheet) is due now and listed as "needs a time".
  if (lastOutcome && outcomeDef(lastOutcome.outcome_code)?.callback) {
    const due = lastOutcome.callback_due_at ?? null;
    return { ...withPhones, status: 'callback', next_due_at: due, due_any_time: due && lastOutcome.callback_any_time ? 1 : 0 };
  }
  if (!lastCall) return { ...withPhones, status: 'new', next_due_at: null };
  const lastTimed = timedCalls.at(-1);
  const due = lastTimed ? new Date(Date.parse(lastTimed.requested_at) + retryGap).toISOString() : null;
  return { ...withPhones, status: 'retry', next_due_at: due };
}

function byKey<K extends string>(k: K) {
  return (a: Record<K, string | null>, b: Record<K, string | null>) => (a[k] ?? '').localeCompare(b[k] ?? '');
}

export function loadLeadFacts(db: DB, leadId: string): LeadFacts {
  // The main number first, then the others in order.
  const rows = stmt(
    db,
    `SELECT phone_e164 e164 FROM lead WHERE id = @id AND phone_e164 IS NOT NULL
     UNION ALL SELECT e164 FROM (SELECT e164 FROM lead_other_phone WHERE lead_id = @id AND e164 IS NOT NULL ORDER BY pos)`,
  ).all({ id: leadId }) as { e164: string }[];
  const phones = [...new Set(rows.map((r) => r.e164))];
  return {
    phones,
    blocks: loadPhoneBlocks(db, leadId, phones),
    appt: latestUnitrustAppt(db, leadId),
    calls: stmt(db, 'SELECT id, requested_at, from_number_id, initiation_result, time_known, to_e164 FROM call WHERE lead_id = ? AND voided_at IS NULL')
      .all(leadId) as LeadFacts['calls'],
    outcomes: stmt(
        db,
        `SELECT o.call_id, o.entered_at, o.outcome_code, c.grp, c.marks_dead, c.counts_as_human_contact, o.callback_due_at, o.callback_any_time, o.do_not_call
         FROM call_outcome o
         JOIN call ON call.id = o.call_id
         JOIN outcome_code c ON c.code = o.outcome_code
         WHERE call.lead_id = ? AND call.voided_at IS NULL AND ${CURRENT_OUTCOME}`,
      )
      .all(leadId) as LeadFacts['outcomes'],
    actions: stmt(db, 'SELECT action, created_at FROM lead_action WHERE lead_id = ?').all(leadId) as LeadFacts['actions'],
  };
}

/** The lead's latest Unitrust appointment (by its day, leaving out ones replaced by a reschedule) and its newest result; blue (or cleared) is "not_set". */
function latestUnitrustAppt(db: DB, leadId: string): LeadFacts['appt'] {
  const r = stmt(
    db,
    `SELECT a.created_at, substr(a.scheduled_for, 1, 10) day, (SELECT result FROM appointment_result r WHERE r.appointment_id = a.id ORDER BY entered_at DESC, id DESC LIMIT 1) result,
            (SELECT max(entered_at) FROM appointment_result r WHERE r.appointment_id = a.id) result_at
     FROM appointment a WHERE a.lead_id = ? AND a.recorded_via = 'unitrust' AND a.internal_status = 'scheduled'
     ORDER BY a.scheduled_for DESC, a.created_at DESC LIMIT 1`,
  ).get(leadId) as { created_at: string; day: string | null; result: string | null; result_at: string | null } | undefined;
  if (!r) return null;
  // Blue and 'cleared' are stored as no result: booked, not set yet.
  const result: ApptResult = isApptResult(r.result) ? r.result : 'not_set';
  return { result, at: r.result_at ?? r.created_at, day: r.day ?? '' };
}


// Prepared once per database: these run for every lead on a full rebuild.
const prepared = new WeakMap<DB, Map<string, Statement>>();
function stmt(db: DB, sql: string): Statement {
  let m = prepared.get(db);
  if (!m) prepared.set(db, (m = new Map()));
  let st = m.get(sql);
  if (!st) m.set(sql, (st = db.prepare(sql)));
  return st;
}

/** Numbers this lead shares with other leads that ruled them out: marked bad there, or that lead is in the dead pile. */
export function loadPhoneBlocks(db: DB, leadId: string, phones: string[]): PhoneBlock[] {
  if (!phones.length) return [];
  const p = { id: leadId, phones: JSON.stringify(phones) };
  const blocks: PhoneBlock[] = [];
  // A bad number found on another lead's call, unless that lead was restored afterwards.
  const bad = stmt(
    db,
      `SELECT c.to_e164 phone, o.entered_at at, ${LEAD_NAME} who,
              (SELECT max(a.created_at) FROM lead_action a WHERE a.lead_id = c.lead_id AND a.action = 'restore') restored
       FROM call c JOIN call_outcome o ON o.call_id = c.id JOIN outcome_code oc ON oc.code = o.outcome_code JOIN lead l ON l.id = c.lead_id
       WHERE c.to_e164 IN (SELECT value FROM json_each(@phones)) AND c.lead_id != @id AND c.voided_at IS NULL AND oc.grp = 'invalid'
         AND ${CURRENT_OUTCOME}`,
    )
    .all(p) as { phone: string; at: string; who: string; restored: string | null }[];
  for (const b of bad) if (b.at > (b.restored ?? '')) blocks.push({ phone: b.phone, at: b.at, kind: 'bad', who: b.who || 'another lead' });
  // Another lead with the same number that is in the dead pile.
  const others = stmt(
    db,
      `SELECT l.id, ${LEAD_NAME} who,
              (SELECT json_group_array(n.e164) FROM lead_number n WHERE n.lead_id = l.id) numbers_json,
              (SELECT max(a.created_at) FROM lead_action a WHERE a.lead_id = l.id AND a.action = 'restore') restored,
              (SELECT max(a.created_at) FROM lead_action a WHERE a.lead_id = l.id AND a.action = 'mark_dead') dead_action,
              (SELECT max(o.entered_at) FROM call c JOIN call_outcome o ON o.call_id = c.id JOIN outcome_code oc ON oc.code = o.outcome_code
                 WHERE c.lead_id = l.id AND c.voided_at IS NULL AND (oc.marks_dead = 1 OR o.do_not_call = 1)
                   AND ${CURRENT_OUTCOME}) dead_outcome
       FROM lead l
       WHERE l.id != @id AND l.id IN (SELECT lead_id FROM lead_number WHERE e164 IN (SELECT value FROM json_each(@phones)))`,
    )
    .all(p) as { who: string; numbers_json: string; restored: string | null; dead_action: string | null; dead_outcome: string | null }[];
  for (const o of others) {
    const deadAt = [o.dead_action, o.dead_outcome].filter((x): x is string => !!x).sort().at(-1);
    if (!deadAt || deadAt <= (o.restored ?? '')) continue;
    for (const ph of new Set(JSON.parse(o.numbers_json) as string[])) {
      if (phones.includes(ph)) blocks.push({ phone: ph, at: deadAt, kind: 'dead', who: o.who || 'another lead' });
    }
  }
  return blocks;
}

/** Other leads that share a number with these leads (their own numbers, or numbers their calls went to). */
export function leadsSharingPhones(db: DB, leadIds: string[]): string[] {
  if (!leadIds.length) return [];
  // A Set: imports pass tens of thousands of ids here.
  const given = new Set(leadIds);
  const ids = JSON.stringify(leadIds);
  const phones = (
    db
      .prepare(
        `SELECT e164 p FROM lead_number WHERE lead_id IN (SELECT value FROM json_each(@ids))
         UNION SELECT to_e164 FROM call WHERE lead_id IN (SELECT value FROM json_each(@ids))`,
      )
      .all({ ids }) as { p: string | null }[]
  )
    .map((r) => r.p)
    .filter((x): x is string => !!x);
  if (!phones.length) return [];
  const ph = JSON.stringify(phones);
  return (
    db
      .prepare(
        `SELECT DISTINCT lead_id id FROM lead_number WHERE e164 IN (SELECT value FROM json_each(@ph))`,
      )
      .all({ ph }) as { id: string }[]
  )
    .map((r) => r.id)
    .filter((id) => !given.has(id));
}

const UPSERT = `INSERT INTO lead_state (lead_id, status, attempts_total, last_call_at, last_outcome_code, next_due_at,
    due_any_time, skipped_at, preferred_number_id, active_phone_e164, blocked_phones_json, block_reason, appt_result, appt_missed, derived_at)
  VALUES (@lead_id, @status, @attempts_total, @last_call_at, @last_outcome_code, @next_due_at, @due_any_time, @skipped_at,
    @preferred_number_id, @active_phone_e164, @blocked_phones_json, @block_reason, @appt_result, @appt_missed, @derived_at)
  ON CONFLICT(lead_id) DO UPDATE SET status = excluded.status, attempts_total = excluded.attempts_total,
    last_call_at = excluded.last_call_at, last_outcome_code = excluded.last_outcome_code, next_due_at = excluded.next_due_at,
    due_any_time = excluded.due_any_time,
    skipped_at = excluded.skipped_at, preferred_number_id = excluded.preferred_number_id,
    active_phone_e164 = excluded.active_phone_e164, blocked_phones_json = excluded.blocked_phones_json,
    block_reason = excluded.block_reason, appt_result = excluded.appt_result, appt_missed = excluded.appt_missed,
    derived_at = excluded.derived_at`;

/**
 * Recomputes lead_state for the given leads (all leads when omitted), and for every lead that shares a number with
 * them, since a bad number or a dead-pile lead rules that number out on the others too.
 */
export function rebuildLeadState(db: DB, leadIds?: string[], now = nowIso()): number {
  const ids = leadIds
    ? [...new Set([...leadIds, ...leadsSharingPhones(db, leadIds)])]
    : (db.prepare('SELECT id FROM lead').all() as { id: string }[]).map((r) => r.id);
  const up = db.prepare(UPSERT);
  const gap = retryGapMs(db);
  const plans = followUpPlans(db);
  db.transaction(() => {
    for (const id of ids) up.run({ lead_id: id, ...deriveLeadState(loadLeadFacts(db, id), now, gap, plans), derived_at: now });
  })();
  return ids.length;
}

/** Compares stored lead_state with a fresh derivation. Returns lead ids that differ. */
export function verifyLeadState(db: DB, now = nowIso()): string[] {
  const rows = db.prepare('SELECT * FROM lead_state').all() as (DerivedLeadState & { lead_id: string })[];
  const keys: (keyof DerivedLeadState)[] = [
    'attempts_total', 'last_call_at', 'last_outcome_code', 'skipped_at', 'preferred_number_id', 'active_phone_e164', 'blocked_phones_json',
    'appt_result', 'appt_missed',
  ];
  const bad: string[] = [];
  const gap = retryGapMs(db);
  const plans = followUpPlans(db);
  for (const r of rows) {
    const d = deriveLeadState(loadLeadFacts(db, r.lead_id), now, gap, plans);
    // Status/next_due depend on "now" for retries, so compare the time-independent fields
    // plus status for leads whose status cannot change with time.
    const timeless = LEAD_STATUSES[d.status].timeless;
    if (keys.some((k) => d[k] !== r[k]) || (timeless && d.status !== r.status)) bad.push(r.lead_id);
  }
  const missing = db.prepare('SELECT id FROM lead WHERE id NOT IN (SELECT lead_id FROM lead_state)').all() as { id: string }[];
  return [...bad, ...missing.map((m) => m.id)];
}
