import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDb, sampleCsv, dueLeads } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, changeOutcome, currentOutcome, addLeadAction, voidCall, changeCallerId, callHistory } from '../../src/server/domain/calls.js';
import { DomainError } from '../../src/server/core/errors.js';
import { activeObjectionCodes, objectionCounts } from '../../src/server/domain/objections.js';
import { addToCallList } from '../../src/server/domain/callList.js';
import { mapSheetStatus } from '../../src/server/domain/sheetHistory.js';
import { buildReport } from '../../src/server/domain/reports.js';
import { rebuildLeadState, verifyLeadState } from '../../src/server/domain/leadState.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

let db: DB;
let jane: string;
let num: string;

beforeEach(async () => {
  ({ db } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  jane = (db.prepare("SELECT id FROM lead WHERE first_name = 'Jane'").get() as any).id;
  num = uuidv7();
  db.prepare("INSERT INTO caller_number (id, e164, label, created_at) VALUES (?, '+16145550199', 'Line A', ?)").run(num, new Date().toISOString());
});

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/server/db/migrations');
const key = () => `k-${uuidv7()}`;

describe('manual call logging', () => {
  it('T4: multiple calls to the same lead stay separate records', () => {
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', from_number_id: num });
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', from_number_id: num });
    const calls = db.prepare('SELECT * FROM call WHERE lead_id = ?').all(jane) as any[];
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    expect(db.prepare('SELECT attempts_total, last_outcome_code FROM lead_state WHERE lead_id = ?').get(jane)).toEqual({
      attempts_total: 2, last_outcome_code: 'no_answer',
    });
  });

  it('T5 (manual): records destination and caller ID used', () => {
    const { call_id } = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', from_number_id: num });
    expect(db.prepare('SELECT to_e164, from_e164, from_number_id FROM call WHERE id = ?').get(call_id)).toEqual({
      to_e164: '+16145550101', from_e164: '+16145550199', from_number_id: num,
    });
  });

  it('keeps the time spent on the lead, and hands it back on undo', () => {
    const { call_id } = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', lead_seconds: 74.6 });
    expect((db.prepare('SELECT lead_seconds FROM call WHERE id = ?').get(call_id) as any).lead_seconds).toBe(75);
    expect(voidCall(db, call_id).lead_seconds).toBe(75);
    const other = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    expect((db.prepare('SELECT lead_seconds FROM call WHERE id = ?').get(other.call_id) as any).lead_seconds).toBeNull();
  });

  it('a repeated submit with the same key does not create a second call', () => {
    const k = key();
    const a = logManualCall(db, { lead_id: jane, idempotency_key: k, outcome_code: 'no_answer' });
    const b = logManualCall(db, { lead_id: jane, idempotency_key: k, outcome_code: 'no_answer' });
    expect(b).toEqual({ call_id: a.call_id, duplicate: true });
    expect((db.prepare('SELECT COUNT(*) n FROM call').get() as any).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM call_event').get() as any).n).toBe(1);
  });

  it('T12: changing an outcome keeps the old outcome and the raw event', () => {
    const { call_id } = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    const first = currentOutcome(db, call_id)!;
    changeOutcome(db, call_id, { outcome_code: 'no_answer', expected_current_id: first.id });
    expect(currentOutcome(db, call_id)!.outcome_code).toBe('no_answer');
    expect((db.prepare('SELECT COUNT(*) n FROM call_outcome WHERE call_id = ?').get(call_id) as any).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) n FROM call_event WHERE call_id = ?').get(call_id) as any).n).toBe(1);
    // A stale edit (double submit or second tab) is refused instead of forking the history.
    expect(() => changeOutcome(db, call_id, { outcome_code: 'no_answer', expected_current_id: first.id })).toThrow(/changed elsewhere/);
  });

  it('callback requires a time and drives the queue', () => {
    expect(() => logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'callback' })).toThrow(DomainError);
    const due = new Date(Date.now() - 60_000).toISOString();
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'callback', callback_due_at: due });
    expect(dueLeads(db).find((l) => l.id === jane)).toMatchObject({ status: 'callback' });
  });

  it('the Do not call tick: counts as reaching the lead, goes to the dead pile and stays off call lists', () => {
    expect(() => logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'dnc_request' })).toThrow(/retired/);
    const r = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_appt', do_not_call: true, from_number_id: num });
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane) as any).status).toBe('dead');
    expect(dueLeads(db).map((l) => l.id)).not.toContain(jane);
    expect(addToCallList(db, [jane])).toEqual({ added: 0, already: 0, not_callable: 1 });
    const day = new Date(Date.now() - 86_400_000).toISOString();
    const rep = buildReport(db, { from: day, to: new Date(Date.now() + 86_400_000).toISOString(), tz: 'America/New_York' });
    expect(rep.activity).toMatchObject({ attempts: 1, contacts: 1, bad_numbers: 0 });
    // The caller ID that reached them is remembered, as for any pickup.
    expect((db.prepare('SELECT preferred_number_id FROM lead_state WHERE lead_id = ?').get(jane) as any).preferred_number_id).toBe(num);
    // Changing the outcome keeps the tick unless you untick it.
    const cur = currentOutcome(db, r.call_id)!;
    changeOutcome(db, r.call_id, { outcome_code: 'appointment', expected_current_id: cur.id });
    expect(currentOutcome(db, r.call_id)).toMatchObject({ outcome_code: 'appointment', do_not_call: 1 });
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane) as any).status).toBe('dead');
    changeOutcome(db, r.call_id, { outcome_code: 'no_appt', expected_current_id: currentOutcome(db, r.call_id)!.id, do_not_call: false });
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane) as any).status).toBe('retry');
  });

  it('a spreadsheet status of "do not call" or "dnc" imports as Talked, no appt with the tick', () => {
    expect(mapSheetStatus('Do Not Call')).toEqual({ outcome: 'no_appt', do_not_call: true });
    expect(mapSheetStatus('DNC')).toEqual({ outcome: 'no_appt', do_not_call: true });
  });

  it('undoing a Do not call call takes the lead out of the dead pile and hands the tick back', () => {
    const r = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_appt', do_not_call: true });
    expect(voidCall(db, r.call_id)).toMatchObject({ outcome_code: 'no_appt', do_not_call: true });
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane) as any).status).toBe('new');
  });

  it('turns calls saved as the old "Do not call" outcome into Talked, no appt with the tick', () => {
    const r = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_appt' });
    db.prepare("UPDATE call_outcome SET outcome_code = 'dnc_request', note = 'asked' WHERE call_id = ?").run(r.call_id);
    const sql = fs.readFileSync(path.join(MIGRATIONS, '017_do_not_call_tick.sql'), 'utf8');
    db.exec(sql.slice(sql.indexOf('INSERT INTO call_outcome'), sql.indexOf('-- Back to five')));
    expect(currentOutcome(db, r.call_id)).toMatchObject({ outcome_code: 'no_appt', do_not_call: 1, note: 'asked' });
    const old = db.prepare("SELECT id, entered_at FROM call_outcome WHERE call_id = ? AND outcome_code = 'dnc_request'").get(r.call_id) as any;
    expect(currentOutcome(db, r.call_id)).toMatchObject({ supersedes_id: old.id, entered_at: old.entered_at });
    expect(currentOutcome(db, r.call_id)!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    rebuildLeadState(db, [jane]);
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane) as any).status).toBe('dead');
  });

  it('a lead can still go to the dead pile from the lead page, and be restored', () => {
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_appt' });
    addLeadAction(db, jane, 'mark_dead', 'asked not to be called');
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane) as any).status).toBe('dead');
    expect(dueLeads(db).map((l) => l.id)).not.toContain(jane);
    addLeadAction(db, jane, 'restore', 'asked to be called after all');
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane) as any).status).toBe('retry');
  });

  it('offers five outcomes on keys 1 to 5', () => {
    expect(db.prepare("SELECT hotkey, code, label FROM outcome_code WHERE active = 1 AND kind = 'first_call' ORDER BY sort_order").all()).toEqual([
      { hotkey: '1', code: 'no_answer', label: 'No answer' },
      { hotkey: '2', code: 'no_appt', label: 'Talked, no appt' },
      { hotkey: '3', code: 'appointment', label: 'Appt set' },
      { hotkey: '4', code: 'bad_number', label: 'Bad number' },
      { hotkey: '5', code: 'callback', label: 'Callback' },
    ]);
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_appt' });
    expect(db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane)).toEqual({ status: 'retry' }); // back after the gap
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'bad_number' });
    expect(db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane)).toEqual({ status: 'invalid' });
  });

  it('offers five appointment outcomes on the same keys 1 to 5', () => {
    expect(db.prepare("SELECT hotkey, code, label FROM outcome_code WHERE active = 1 AND kind = 'appointment' ORDER BY sort_order").all()).toEqual([
      { hotkey: '1', code: 'appt_no_show', label: 'No show' },
      { hotkey: '2', code: 'appt_sat_no_sale', label: 'Sat, no sale' },
      { hotkey: '3', code: 'appt_prezi', label: 'Prezi' },
      { hotkey: '4', code: 'appt_sale', label: 'Sale' },
      { hotkey: '5', code: 'appt_rescheduled', label: 'Rescheduled' },
    ]);
  });

  it('an appointment call sets how the appointment went: a prezi comes back to be called, a sale stays out', () => {
    const state = () => db.prepare('SELECT status, appt_result, appt_missed FROM lead_state WHERE lead_id = ?').get(jane);
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'appointment' });
    expect(state()).toEqual({ status: 'appointment_set', appt_result: null, appt_missed: 0 });
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'appt_prezi' });
    expect(state()).toEqual({ status: 'retry', appt_result: 'prezi', appt_missed: 1 });
    expect(dueLeads(db).some((l: any) => l.id === jane)).toBe(true);
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'appt_sale' });
    expect(state()).toEqual({ status: 'appointment_set', appt_result: 'sold', appt_missed: 0 });
  });

  it('keeps objections heard on a call, and refuses unknown ones', () => {
    const { call_id } = logManualCall(db, {
      lead_id: jane, idempotency_key: key(), outcome_code: 'appt_prezi', objections: [{ code: 'price' }, { code: 'spouse', note: ' wife decides ' }],
    });
    expect(db.prepare('SELECT objection_code, note, source FROM call_objection WHERE call_id = ? ORDER BY objection_code').all(call_id)).toEqual([
      { objection_code: 'price', note: null, source: 'manual' },
      { objection_code: 'spouse', note: 'wife decides', source: 'manual' },
    ]);
    expect(objectionCounts(db, '2000-01-01', '2100-01-01').map((o) => [o.code, o.n])).toEqual([['price', 1], ['spouse', 1]]);
    expect(() => logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'appt_prezi', objections: [{ code: 'nope' }] })).toThrow(DomainError);
    expect(db.prepare("SELECT COUNT(*) n FROM call WHERE lead_id = ? AND voided_at IS NULL").get(jane)).toEqual({ n: 1 });
  });

  it('offers the objections in order, and an undo gives back the ones you picked', () => {
    expect(activeObjectionCodes(db).map((o) => o.label)).toEqual(['Price', 'Spouse', 'Already covered', 'Think about it', 'Health', 'Trust', 'Other']);
    const { call_id } = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_appt', objections: [{ code: 'think_about_it' }, { code: 'price' }] });
    expect(voidCall(db, call_id).objections).toEqual(['think_about_it', 'price']);
    // An undone call's objections don't count.
    expect(objectionCounts(db, '2000-01-01', '2100-01-01')).toEqual([]);
  });

    it('a callback can be for a day, any time: due from the start of that day', () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const tomorrow = new Date(start.getTime() + 86_400_000).toISOString();
    const r = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'callback', callback_due_at: tomorrow, callback_any_time: true });
    expect(db.prepare('SELECT status, next_due_at, due_any_time FROM lead_state WHERE lead_id = ?').get(jane)).toEqual({
      status: 'callback', next_due_at: tomorrow, due_any_time: 1,
    });
    expect(dueLeads(db).map((l) => l.id)).not.toContain(jane); // not due yet
    const later = dueLeads(db, { now: new Date(start.getTime() + 86_400_000 + 9 * 3600_000).toISOString() });
    expect(later.find((l) => l.id === jane)).toMatchObject({ status: 'callback', next_due_at: tomorrow });
    // Undo hands it back as it was entered.
    expect(voidCall(db, r.call_id)).toMatchObject({ callback_due_at: tomorrow, callback_any_time: true });
    expect(verifyLeadState(db)).toEqual([]);
  });

  it('appointment set has no date, leaves the queue, and remembers the caller ID it was set from', () => {
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'appointment', from_number_id: num });
    expect(db.prepare('SELECT count(*) n FROM appointment').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status, next_due_at, preferred_number_id FROM lead_state WHERE lead_id = ?').get(jane)).toEqual({
      status: 'appointment_set', next_due_at: null, preferred_number_id: num,
    });
    expect(dueLeads(db).map((l) => l.id)).not.toContain(jane);
  });

  it('rebuild reproduces stored lead state exactly', () => {
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', from_number_id: num });
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_appt', from_number_id: num });
    const before = db.prepare('SELECT * FROM lead_state ORDER BY lead_id').all() as any[];
    db.prepare('DELETE FROM lead_state').run();
    expect(verifyLeadState(db).length).toBe(4);
    rebuildLeadState(db);
    const after = db.prepare('SELECT * FROM lead_state ORDER BY lead_id').all() as any[];
    const strip = (r: any) => ({ ...r, derived_at: undefined });
    expect(after.map(strip)).toEqual(before.map(strip));
    expect(verifyLeadState(db)).toEqual([]);
  });

  it('refuses retired caller IDs and future call times', () => {
    db.prepare("UPDATE caller_number SET status = 'retired' WHERE id = ?").run(num);
    expect(() => logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', from_number_id: num })).toThrow(/retired/);
    expect(() =>
      logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', occurred_at: new Date(Date.now() + 3_600_000).toISOString() }),
    ).toThrow(/future/);
  });
});

describe('changing the caller ID on many calls', () => {
  it('moves the calls to the new number, keeps a record, and fixes the remembered number', () => {
    const other = uuidv7();
    db.prepare("INSERT INTO caller_number (id, e164, label, created_at) VALUES (?, '+16145550188', 'Line B', ?)").run(other, new Date().toISOString());
    const a = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_appt', from_number_id: num }).call_id;
    const b = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', from_number_id: num }).call_id;
    const done = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', from_number_id: other }).call_id;
    const undone = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', from_number_id: num }).call_id;
    voidCall(db, undone);
    expect((db.prepare('SELECT preferred_number_id FROM lead_state WHERE lead_id = ?').get(jane) as any).preferred_number_id).toBe(num);

    const r = changeCallerId(db, [a, b, done, undone, 'nope', a], other);
    expect(r).toEqual({ changed: 2, skipped: { undone: 1, same: 1, missing: 1 } });
    expect(db.prepare('SELECT from_number_id, from_e164 FROM call WHERE id = ?').get(a)).toEqual({ from_number_id: other, from_e164: '+16145550188' });
    expect((db.prepare('SELECT from_number_id FROM call WHERE id = ?').get(undone) as any).from_number_id).toBe(num);
    expect((db.prepare('SELECT preferred_number_id FROM lead_state WHERE lead_id = ?').get(jane) as any).preferred_number_id).toBe(other);
    const log = db.prepare("SELECT old_json, new_json FROM audit_log WHERE table_name = 'call' AND row_id = ?").get(a) as any;
    expect(JSON.parse(log.old_json)).toEqual({ from_number_id: num, from_e164: '+16145550199' });
    expect(JSON.parse(log.new_json)).toEqual({ from_number_id: other, from_e164: '+16145550188' });
    expect(db.prepare("SELECT count(*) n FROM call_event WHERE call_id = ? AND event_type = 'call.caller_id_changed'").get(a)).toEqual({ n: 1 });

    // Call history filters by caller ID, including calls with none.
    expect(callHistory(db, { fromNumber: num }).map((c: any) => c.id)).toEqual([undone]);
    changeCallerId(db, [b], null);
    expect((db.prepare('SELECT from_number_id, from_e164 FROM call WHERE id = ?').get(b) as any)).toEqual({ from_number_id: null, from_e164: null });
    expect(callHistory(db, { fromNumber: 'none' }).map((c: any) => c.id)).toEqual([b]);
    expect(() => changeCallerId(db, [a], 'nope')).toThrow(/not found/);
  });
});
