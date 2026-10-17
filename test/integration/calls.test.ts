import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, changeOutcome, currentOutcome, addLeadAction, voidCall, DomainError } from '../../src/server/domain/calls.js';
import { getQueue } from '../../src/server/domain/queue.js';
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
    const q = getQueue(db);
    expect(q.items[0]).toMatchObject({ lead_id: jane, bucket: 'callback_due' });
  });

  it('a do-not-call request goes to the dead pile from the lead page, and can be restored', () => {
    expect(() => logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'dnc_request' })).toThrow(/retired/);
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_appt' });
    addLeadAction(db, jane, 'mark_dead', 'asked not to be called');
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane) as any).status).toBe('dead');
    expect(getQueue(db).items.find((i) => i.lead_id === jane)).toBeUndefined();
    addLeadAction(db, jane, 'restore', 'asked to be called after all');
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane) as any).status).toBe('retry');
  });

  it('offers five outcomes on keys 1 to 5', () => {
    expect(db.prepare('SELECT hotkey, code, label FROM outcome_code WHERE active = 1 ORDER BY sort_order').all()).toEqual([
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

  it('a callback can be for a day, any time: due from the start of that day', () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const tomorrow = new Date(start.getTime() + 86_400_000).toISOString();
    const r = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'callback', callback_due_at: tomorrow, callback_any_time: true });
    expect(db.prepare('SELECT status, next_due_at, due_any_time FROM lead_state WHERE lead_id = ?').get(jane)).toEqual({
      status: 'callback', next_due_at: tomorrow, due_any_time: 1,
    });
    expect(getQueue(db).items.find((i) => i.lead_id === jane)).toBeUndefined(); // not due yet
    const q = getQueue(db, { now: new Date(start.getTime() + 86_400_000 + 9 * 3600_000).toISOString() });
    expect(q.items.find((i) => i.lead_id === jane)).toMatchObject({ bucket: 'callback_due', any_time: true, needs_time: false });
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
    expect(getQueue(db).items.map((i) => i.lead_id)).not.toContain(jane);
  });

  it('queue: new leads first by batch, skipped leads drop to the end', () => {
    const q1 = getQueue(db);
    expect(q1.counts.new).toBe(4);
    const first = q1.items[0]!.lead_id;
    addLeadAction(db, first, 'skip');
    const q2 = getQueue(db);
    expect(q2.items.at(-1)!.lead_id).toBe(first);
    expect(q2.items.at(-1)!.skipped_today).toBe(true);
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
