import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import type { OutcomeCode } from '../../shared/outcomes.js';

// A spreadsheet's Status column has no times. Each status becomes one call marked "from spreadsheet,
// exact time unknown" (time_known = 0), dated on or before the day the file was last saved.
// These calls count as attempts and in the funnel, are left out of by-day and by-hour reports,
// and don't hold the lead back under the retry gap.

export interface SheetStatusMapping {
  outcome: OutcomeCode;
  /** They asked not to be called: the call gets the "Do not call" tick. */
  do_not_call?: boolean;
}

const STATUS_MAP: Record<string, SheetStatusMapping> = {
  dialed: { outcome: 'no_answer' },
  'no answer': { outcome: 'no_answer' },
  'picked up': { outcome: 'no_appt' },
  contacted: { outcome: 'no_appt' },
  talked: { outcome: 'no_appt' },
  'not interested': { outcome: 'no_appt' },
  'no appt': { outcome: 'no_appt' },
  disconnected: { outcome: 'bad_number' },
  'wrong number': { outcome: 'bad_number' },
  'bad number': { outcome: 'bad_number' },
  'do not call': { outcome: 'no_appt', do_not_call: true },
  dnc: { outcome: 'no_appt', do_not_call: true },
  // How appointments went is kept in Unitrust; here they all mean "appointment set". The call's note keeps the original words.
  'appt set': { outcome: 'appointment' },
  'appointment set': { outcome: 'appointment' },
  'appt showed no sale': { outcome: 'appointment' },
  'appt showed, no sale': { outcome: 'appointment' },
  'showed no sale': { outcome: 'appointment' },
  sold: { outcome: 'appointment' },
  reschedule: { outcome: 'callback' },
  rescheduled: { outcome: 'callback' },
  callback: { outcome: 'callback' },
};

export function mapSheetStatus(raw: string): SheetStatusMapping | null {
  const k = raw.toLowerCase().replace(/[^a-z, ]/g, ' ').replace(/\s+/g, ' ').trim();
  return STATUS_MAP[k] ?? STATUS_MAP[k.replace(/,/g, '')] ?? null;
}

export interface SheetHistoryResult {
  calls: number;
  unknown: { leadId: string; status: string }[];
}

export function recordSheetHistory(
  db: DB,
  items: { leadId: string; status: string; phone: string }[],
  fileDate: string,
): SheetHistoryResult {
  const now = nowIso();
  const at = fileDate > now ? now : fileDate;
  const insCall = db.prepare(
    `INSERT INTO call (id, lead_id, direction, channel, to_e164, requested_at, idempotency_key, initiation_result, state,
      state_confirmed_by, history_source, time_known, derived_at)
     VALUES (?, ?, 'outbound', 'manual_log', ?, ?, ?, 'accepted', 'ended', 'manual', 'sheet', 0, ?)`,
  );
  const insEvent = db.prepare(
    `INSERT INTO call_event (id, call_id, source, dedup_key, event_type_raw, event_type, occurred_at, received_at, payload_json)
     VALUES (?, ?, 'manual', ?, 'sheet.status', 'call.from_sheet', ?, ?, ?)`,
  );
  const insOutcome = db.prepare(
    `INSERT INTO call_outcome (id, call_id, outcome_code, entered_at, callback_due_at, note, do_not_call) VALUES (?,?,?,?,NULL,?,?)`,
  );
  const result: SheetHistoryResult = { calls: 0, unknown: [] };
  for (const it of items) {
    const m = mapSheetStatus(it.status);
    if (!m) {
      result.unknown.push({ leadId: it.leadId, status: it.status });
      continue;
    }
    const callId = uuidv7();
    const note = `From spreadsheet status "${it.status}" (exact time unknown, on or before ${at.slice(0, 10)})`;
    insCall.run(callId, it.leadId, it.phone, at, `sheet:${it.leadId}`, now);
    insEvent.run(uuidv7(), callId, `sheet:${callId}`, at, now, JSON.stringify({ status: it.status }));
    insOutcome.run(uuidv7(), callId, m.outcome, now, note, m.do_not_call ? 1 : 0);
    result.calls++;
  }
  return result;
}
