import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { addToCallList, leadFilterWhere } from '../../src/server/domain/callList.js';
import { appointmentCounts, appointmentsOnDays, recordUnitrustEvents, type UnitrustEvent } from '../../src/server/domain/unitrustAppointments.js';
import { buildReport, todayStats } from '../../src/server/domain/reports.js';
import { verifyLeadState } from '../../src/server/domain/leadState.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';
import type { Config } from '../../src/server/config.js';
import { uuidv7 } from '../../src/server/ids.js';

let db: DB;
let config: Config;
const id = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const state = (leadId: string) => db.prepare('SELECT status, appt_result, appt_missed, next_due_at FROM lead_state WHERE lead_id = ?').get(leadId) as {
  status: string; appt_result: string | null; appt_missed: number; next_due_at: string | null;
};
const ev = (color: UnitrustEvent['color'], title = 'OH - ROCKET MORTG - ROBERT RAY- (614) 555-0102 RAY', date = '2026-10-26'): UnitrustEvent => ({ title, date, time: '10:00', color });
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const inTab = (status: string) => {
  const w = leadFilterWhere({ status });
  return (db.prepare(`SELECT l.first_name f FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE ${w.sql}`).all(w.params) as { f: string }[]).map((r) => r.f);
};

beforeEach(async () => {
  ({ db, c: config } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
});

describe('appointments from the Unitrust calendar', () => {
  it('a booked lead that turns red comes back to be called, and goes on the call list', () => {
    const robert = id('Robert');
    logManualCall(db, { lead_id: robert, idempotency_key: `k-${uuidv7()}`, outcome_code: 'appointment' });
    expect(state(robert).status).toBe('appointment_set');

    expect(recordUnitrustEvents(db, [ev('blue')], {}, later(1))).toMatchObject({ seen: 1, matched: 1, added: 1, changed: 0, unmatched: [] });
    expect(state(robert)).toMatchObject({ status: 'appointment_set', appt_result: 'not_set', appt_missed: 0 });
    expect(addToCallList(db, [robert]).not_callable).toBe(1);

    expect(recordUnitrustEvents(db, [ev('red')], {}, later(2))).toMatchObject({ seen: 1, added: 0, changed: 1 });
    expect(state(robert)).toMatchObject({ status: 'retry', appt_result: 'no_show', appt_missed: 1, next_due_at: null });
    expect(inTab('appt_missed')).toEqual(['Robert']);
    expect(inTab('talked')).not.toContain('Robert');
    expect(inTab('no_answer')).not.toContain('Robert');
    expect(addToCallList(db, [robert]).added).toBe(1);

    // The same color again changes nothing.
    expect(recordUnitrustEvents(db, [ev('red')], {}, later(3)).changed).toBe(0);
    expect(verifyLeadState(db)).toEqual([]);
  });

  it('calling the no-show again takes over; green stays booked; yellow comes back', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const robert = id('Robert');
    logManualCall(db, { lead_id: robert, idempotency_key: `k-${uuidv7()}`, outcome_code: 'appointment' });
    await tick();
    recordUnitrustEvents(db, [ev('red')]);
    expect(state(robert).appt_missed).toBe(1);
    await tick();
    logManualCall(db, { lead_id: robert, idempotency_key: `k-${uuidv7()}`, outcome_code: 'no_answer' });
    // A call after the no-show: an ordinary no-answer now.
    const s = state(robert);
    expect(s.appt_missed).toBe(0);
    expect(inTab('appt_missed')).toEqual([]);

    recordUnitrustEvents(db, [ev('green', undefined, '2026-10-30')], {}, later(10));
    expect(state(robert)).toMatchObject({ status: 'appointment_set', appt_result: 'sold' });
    // Yellow on its own day (not later than today): sat, no sale.
    recordUnitrustEvents(db, [ev('yellow', undefined, '2026-10-30')], { today: '2026-10-30' }, later(11));
    expect(state(robert)).toMatchObject({ status: 'retry', appt_result: 'sat_no_sale', appt_missed: 1 });
  });

  it('matches by phone, uses the name when leads share a number, and reports what it cannot match', () => {
    // Jane and John Doe share (614) 555-0101.
    const r = recordUnitrustEvents(db, [
      ev('blue', 'OH - ROCKET MORTG - JOHN DOE- (614) 555-0101 DOE'),
      ev('blue', 'OH - CHASE - NOBODY HERE- (999) 999-9999 HERE'),
      ev('blue', 'Dinner at vineyard'),
    ], {}, later(1));
    expect(r).toMatchObject({ seen: 2, matched: 1, unmatched: ['OH - CHASE - NOBODY HERE- (999) 999-9999 HERE'] });
    expect(state(id('John')).appt_result).toBe('not_set');
    expect(state(id('Jane')).appt_result).toBeNull();
  });

  it('the extension posts with its own key, without the app cookie; the key opens nothing else', async () => {
    const app: FastifyInstance = await buildApp({ db, config, token: 'test-token-0123456789abcdef0123456789abcdef' });
    const HOST = '127.0.0.1:5170';
    const auth = { host: HOST, cookie: 'mpcrm_session=test-token-0123456789abcdef0123456789abcdef' };
    const { key } = (await app.inject({ method: 'POST', url: '/api/unitrust/key', headers: { ...auth, origin: `http://${HOST}` } })).json();
    expect(key).toMatch(/^[\w-]{20,}$/);
    const payload = { events: [ev('red')] };
    const ext = { host: HOST, origin: 'moz-extension://abc', 'x-mpcrm-extension-key': key };
    const ok = await app.inject({ method: 'POST', url: '/api/unitrust/events', headers: ext, payload });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ seen: 1, matched: 1 });
    const wrong = await app.inject({ method: 'POST', url: '/api/unitrust/events', headers: { ...ext, 'x-mpcrm-extension-key': 'nope' }, payload });
    expect(wrong.statusCode).toBe(401);
    const elsewhere = await app.inject({ method: 'POST', url: '/api/numbers', headers: ext, payload: { number: '6145550199' } });
    expect(elsewhere.statusCode).toBe(401);
    const view = (await app.inject({ url: '/api/unitrust', headers: auth })).json();
    expect(view).toMatchObject({ key, last_sync: { seen: 1, matched: 1 } });
  });

  it('a yellow that moved to a later day is a reschedule: still booked, and the old one counts as rescheduled', () => {
    const robert = id('Robert');
    const week = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
    logManualCall(db, { lead_id: robert, idempotency_key: `k-${uuidv7()}`, outcome_code: 'appointment' });
    recordUnitrustEvents(db, [ev('blue', undefined, '2026-10-27')], { today: '2026-10-27', days: week }, later(1));
    // Set to reschedule in Unitrust: the event moves to Thursday, yellow. Tuesday no longer has it.
    recordUnitrustEvents(db, [ev('yellow', undefined, '2026-10-29')], { today: '2026-10-29', days: week }, later(2));
    expect(state(robert)).toMatchObject({ status: 'appointment_set', appt_result: 'rescheduled', appt_missed: 0 });
    const days = appointmentsOnDays(db, '2026-10-26', '2026-10-30').map((a) => [a.day, a.outcome]);
    expect(days).toEqual([['2026-10-27', 'rescheduled'], ['2026-10-29', 'pending']]);
    // Then sold on Thursday.
    recordUnitrustEvents(db, [ev('green', undefined, '2026-10-29')], { today: '2026-10-29', days: week }, later(3));
    const c = appointmentCounts(appointmentsOnDays(db, '2026-10-26', '2026-10-30'));
    expect(c).toMatchObject({ appointments: 2, sat: 1, sold: 1, rescheduled: 1, pending: 0, close_rate: 1, show_rate: 1 });
    expect(verifyLeadState(db)).toEqual([]);
  });

  it('a yellow on a later day is a reschedule even when the old day is not on screen; still yellow after that day, sat no sale', () => {
    const robert = id('Robert');
    recordUnitrustEvents(db, [ev('yellow', undefined, '2026-11-03')], { today: '2026-10-28' }, later(1));
    expect(state(robert).appt_result).toBe('rescheduled');
    recordUnitrustEvents(db, [ev('yellow', undefined, '2026-11-03')], { today: '2026-11-04' }, later(2));
    expect(state(robert)).toMatchObject({ appt_result: 'sat_no_sale', status: 'retry', appt_missed: 1 });
  });

  it('the top bar and Reports count the appointments on the day', () => {
    recordUnitrustEvents(db, [
      ev('green', 'OH - ROCKET MORTG - ROBERT RAY- (614) 555-0102 RAY', '2026-10-28'),
      ev('red', 'IL - WELLS FARGO - ANN LEE- (312) 555-0103 LEE', '2026-10-28'),
      ev('blue', 'OH - ROCKET MORTG - JOHN DOE- (614) 555-0101 DOE', '2026-10-29'),
    ], { today: '2026-10-28' }, later(1));
    const t = todayStats(db, '2026-10-28T04:00:00.000Z', '2026-10-29T04:00:00.000Z', '2026-10-28');
    expect(t.appts).toMatchObject({ appointments: 2, sat: 1, sold: 1, no_show: 1, show_rate: 0.5 });
    const r = buildReport(db, { from: '2026-10-28T04:00:00.000Z', to: '2026-10-30T04:00:00.000Z', tz: 'America/New_York' });
    expect(r.appointments).toMatchObject({ appointments: 3, sold: 1, no_show: 1, pending: 1 });
    expect(r.appointments!.rows.map((x) => x.lead_name)).toEqual(['Ann Lee', 'Robert Ray', 'John Doe']);
  });

  it('migration 020 splits yellows stored before as follow_up, by whether the day was after it turned yellow', () => {
    const lead = id('Robert');
    const add = (day: string, seen: string) => {
      const a = uuidv7();
      db.prepare("INSERT INTO appointment (id, lead_id, scheduled_for, recorded_via, created_at) VALUES (?, ?, ?, 'unitrust', ?)").run(a, lead, day, seen);
      db.prepare("INSERT INTO appointment_result (id, appointment_id, result, entered_at) VALUES (?, ?, 'follow_up', ?)").run(uuidv7(), a, seen);
      return a;
    };
    const later_ = add('2026-11-02', '2026-10-28T22:30:00.000Z');
    const same = add('2026-10-28', '2026-10-28T22:30:00.000Z');
    db.exec(fs.readFileSync(path.join(__dirname, '../../src/server/db/migrations/020_unitrust_reschedules.sql'), 'utf8'));
    const result = (a: string) => (db.prepare('SELECT result FROM appointment_result WHERE appointment_id = ?').get(a) as { result: string }).result;
    expect([result(later_), result(same)]).toEqual(['rescheduled', 'sat_no_sale']);
  });
});

describe('appointment calls logged here', () => {
  const log = (leadId: string, code: string, at: string) => logManualCall(db, { lead_id: leadId, idempotency_key: `k-${uuidv7()}`, outcome_code: code, occurred_at: at });

  it('a prezi logged here beats the yellow Unitrust shows for that appointment', () => {
    const robert = id('Robert');
    log(robert, 'appointment', '2026-10-24T15:00:00.000Z');
    recordUnitrustEvents(db, [ev('blue')], { today: '2026-10-25' }, '2026-10-25T12:00:00.000Z');
    log(robert, 'appt_prezi', '2026-10-26T15:00:00.000Z');
    expect(state(robert)).toMatchObject({ status: 'retry', appt_result: 'prezi', appt_missed: 1 });
    // Later you mark it yellow in Unitrust: still a prezi.
    recordUnitrustEvents(db, [ev('yellow')], { today: '2026-10-26' }, later(1));
    expect(state(robert)).toMatchObject({ status: 'retry', appt_result: 'prezi', appt_missed: 1 });
    expect(appointmentsOnDays(db, '2026-10-26', '2026-10-26').map((a) => [a.outcome, a.source])).toEqual([['prezi', 'app']]);
    expect(inTab('appt_prezi')).toEqual(['Robert']);
    expect(inTab('appt_sat_no_sale')).toEqual([]);
    expect(verifyLeadState(db)).toEqual([]);
  });

  it('appointments logged only here count too, and each result has its own tab', () => {
    log(id('Robert'), 'appt_sale', '2026-10-28T15:00:00.000Z');
    log(id('Ann'), 'appt_no_show', '2026-10-28T16:00:00.000Z');
    log(id('John'), 'appt_sat_no_sale', '2026-10-28T17:00:00.000Z');
    expect(inTab('appt_sold')).toEqual(['Robert']);
    expect(inTab('appt_no_show')).toEqual(['Ann']);
    expect(inTab('appt_sat_no_sale')).toEqual(['John']);
    expect(appointmentCounts(appointmentsOnDays(db, '2026-10-28', '2026-10-28'))).toMatchObject({
      appointments: 3, sat: 2, prezis: 1, sold: 1, sat_no_sale: 1, no_show: 1, prezi: 0,
    });
  });

  it('the funnel: dials, pickups and appointments set count first calls only; sat, prezis and sales below them', () => {
    const robert = id('Robert'), ann = id('Ann');
    log(robert, 'appointment', '2026-10-28T14:00:00.000Z');
    log(ann, 'appointment', '2026-10-28T14:10:00.000Z');
    log(robert, 'appt_sale', '2026-10-28T20:00:00.000Z');
    log(ann, 'appt_prezi', '2026-10-28T21:00:00.000Z');
    const t = todayStats(db, '2026-10-28T04:00:00.000Z', '2026-10-29T04:00:00.000Z', undefined, { from: '2026-10-28', to: '2026-10-28' });
    expect(t).toMatchObject({ dials: 2, unique_leads: 2, human_contacts: 2, appointments: 2, funnel: { sat: 2, prezis: 2, sales: 1 } });
    const r = buildReport(db, { from: '2026-10-28T04:00:00.000Z', to: '2026-10-29T04:00:00.000Z', tz: 'America/New_York' });
    expect(r.activity).toMatchObject({ dials: 2, contacts: 2, appointments: 2 });
    expect(r.appointments).toMatchObject({ appointments: 2, sold: 1, prezi: 1, sat: 2 });
  });

  it('the funnel can count appointments for the day instead: set earlier counts, set today for later does not', () => {
    const robert = id('Robert'), ann = id('Ann'), john = id('John');
    log(robert, 'appointment', '2026-10-27T14:00:00.000Z'); // set yesterday for today
    log(ann, 'appointment', '2026-10-28T14:10:00.000Z'); // set today for next week
    log(john, 'appointment', '2026-10-28T14:20:00.000Z'); // set today for today
    recordUnitrustEvents(db, [
      ev('blue', 'OH - ROCKET MORTG - ROBERT RAY- (614) 555-0102 RAY', '2026-10-28'),
      ev('blue', 'OH - ROCKET MORTG - ANN LEE- (312) 555-0103 LEE', '2026-11-04'),
      ev('green', 'OH - ROCKET MORTG - JOHN DOE- (614) 555-0101 DOE', '2026-10-28'),
    ], { today: '2026-10-28' }, '2026-10-28T15:00:00.000Z');
    const t = todayStats(db, '2026-10-28T04:00:00.000Z', '2026-10-29T04:00:00.000Z', undefined, { from: '2026-10-28', to: '2026-10-28' });
    expect(t).toMatchObject({ appointments: 2, funnel: { on_the_day: 2, sales: 1 } });
  });
});
