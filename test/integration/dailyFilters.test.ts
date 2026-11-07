import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { apptDayRange, leadFilterWhere, type LeadFilter } from '../../src/server/domain/callList.js';
import { recordUnitrustEvents, unmarkedAppointments, type UnitrustEvent } from '../../src/server/domain/unitrustAppointments.js';
import { rebuildLeadState } from '../../src/server/domain/leadState.js';
import { lastCallRange } from '../../src/shared/leadFilter.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';
import type { Config } from '../../src/server/config.js';
import { uuidv7 } from '../../src/server/ids.js';

// The Leads filters the daily routine is built on: imported day, appointment day, and not dialed recently.

let db: DB;
let config: Config;
let batch: string;
const id = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const key = () => `k-${uuidv7()}`;
/** YYYY-MM-DD on this computer, `back` days ago. */
const day = (back: number) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const match = (f: LeadFilter) => {
  const w = leadFilterWhere(db, f);
  return (db.prepare(`SELECT l.first_name f FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE ${w.sql}`).all(w.params) as { f: string }[]).map((r) => r.f);
};
const ev = (color: UnitrustEvent['color'], date: string): UnitrustEvent => ({ title: 'OH - ROCKET MORTG - ROBERT RAY- (614) 555-0102 RAY', date, time: '10:00', color });
/** Moves every call back `days` days (keeping the time of day). */
const callsBack = (days: number) => {
  db.prepare(`UPDATE call SET requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', requested_at, '-${days} days')`).run();
  rebuildLeadState(db);
};

beforeEach(async () => {
  ({ db, c: config } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  batch = commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' }).batchId;
});

describe('daily filters', () => {
  it('imported today, yesterday or this week counts every file imported then', () => {
    const all = match({});
    expect(match({ imported: 'today' })).toEqual(all);
    expect(match({ imported: 'yesterday' })).toEqual([]);
    db.prepare(`UPDATE import_batch SET imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') WHERE id = ?`).run(batch);
    expect(match({ imported: 'today' })).toEqual([]);
    expect(match({ imported: 'yesterday' })).toEqual(all);
    expect(match({ imported: 'week' })).toEqual(all);
    db.prepare(`UPDATE import_batch SET imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-9 days') WHERE id = ?`).run(batch);
    expect(match({ imported: 'week' })).toEqual([]);
  });

  it("appointment day: yesterday's no-shows, and since my last calling day", () => {
    const robert = id('Robert');
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'appointment' });
    callsBack(4);
    recordUnitrustEvents(db, [ev('red', day(1))], { today: day(0) });
    expect(match({ status: 'appt_no_show', appt_days: 'yesterday' })).toEqual(['Robert']);
    expect(match({ status: 'appt_sold', appt_days: 'yesterday' })).toEqual([]);

    // The last call was 4 days ago, so "since my last calling day" runs from then through yesterday.
    expect(apptDayRange(db, 'since_last_calling_day')).toEqual({ from: day(4), to: day(1) });
    expect(apptDayRange(db, 'yesterday')).toEqual({ from: day(1), to: day(1) });
  });

  it('an appointment from before the range does not count, and no calls at all means yesterday', () => {
    expect(apptDayRange(db, 'since_last_calling_day')).toEqual({ from: day(1), to: day(1) });
    const robert = id('Robert');
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'appointment' });
    callsBack(5);
    recordUnitrustEvents(db, [ev('red', day(3))], { today: day(0) });
    expect(match({ status: 'appt_no_show', appt_days: 'yesterday' })).toEqual([]);
    expect(match({ status: 'appt_no_show', appt_days: 'since_last_calling_day' })).toEqual(['Robert']);
  });

  it('blue appointments in the range are listed until they are marked', () => {
    const robert = id('Robert');
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'appointment' });
    callsBack(2);
    recordUnitrustEvents(db, [ev('blue', day(1))], { today: day(0) });
    expect(unmarkedAppointments(db, 'yesterday').appointments.map((a) => a.lead_id)).toEqual([robert]);
    recordUnitrustEvents(db, [ev('red', day(1))], { today: day(0) });
    expect(unmarkedAppointments(db, 'yesterday').appointments).toEqual([]);
  });

  it('not dialed in the last N minutes leaves out recent calls but keeps never-called leads', () => {
    const jane = id('Jane');
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    expect(match({ status: 'no_answer' })).toEqual(['Jane']);
    expect(match({ status: 'no_answer', not_within_min: 60 })).toEqual([]);
    expect(match({ not_within_min: 60 })).not.toContain('Jane');
    expect(match({ status: 'new', not_within_min: 60 }).length).toBeGreaterThan(0);
    callsBack(1);
    expect(match({ status: 'no_answer', not_within_min: 60 })).toEqual(['Jane']);
  });

  it('last call choices: today, and called before but not today', () => {
    const r = lastCallRange('today');
    expect(new Date(r.after!).getHours()).toBe(0);
    const jane = id('Jane');
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    const range = (k: Parameters<typeof lastCallRange>[0]) => ({ tried_after: lastCallRange(k).after, tried_before: lastCallRange(k).before });
    expect(match(range('today'))).toEqual(['Jane']);
    expect(match(range('not_today'))).toEqual([]);
    callsBack(1);
    expect(match(range('today'))).toEqual([]);
    expect(match(range('not_today'))).toEqual(['Jane']);
  });

  it('over HTTP: the new filters, and the blue appointments', async () => {
    const jane = id('Jane');
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
    const headers = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };
    const app = await buildApp({ db, config, token: TOKEN });
    const get = (url: string) => app.inject({ url, headers });
    expect((await get('/api/leads?status=no_answer&last_call=today&imported=today')).json().rows.map((x: { id: string }) => x.id)).toEqual([jane]);
    expect((await get('/api/leads?status=no_answer&last_call=today&not_within_min=60')).json().total).toBe(0);
    expect((await get('/api/leads?last_call=sometime')).statusCode).toBe(400);
    expect((await get('/api/leads?appt_days=last_week')).statusCode).toBe(400);
    const r = await get('/api/appointments/unmarked?days=yesterday');
    expect(r.json()).toEqual({ from: day(1), to: day(1), appointments: [] });
    await app.close();
  });
});
