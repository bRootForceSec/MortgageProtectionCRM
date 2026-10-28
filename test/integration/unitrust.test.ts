import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { addToCallList, leadFilterWhere } from '../../src/server/domain/callList.js';
import { recordUnitrustEvents, type UnitrustEvent } from '../../src/server/domain/unitrustAppointments.js';
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

    expect(recordUnitrustEvents(db, [ev('blue')], later(1))).toMatchObject({ seen: 1, matched: 1, added: 1, changed: 0, unmatched: [] });
    expect(state(robert)).toMatchObject({ status: 'appointment_set', appt_result: 'not_set', appt_missed: 0 });
    expect(addToCallList(db, [robert]).not_callable).toBe(1);

    expect(recordUnitrustEvents(db, [ev('red')], later(2))).toMatchObject({ seen: 1, added: 0, changed: 1 });
    expect(state(robert)).toMatchObject({ status: 'retry', appt_result: 'no_show', appt_missed: 1, next_due_at: null });
    expect(inTab('appt_missed')).toEqual(['Robert']);
    expect(inTab('talked')).not.toContain('Robert');
    expect(inTab('no_answer')).not.toContain('Robert');
    expect(addToCallList(db, [robert]).added).toBe(1);

    // The same color again changes nothing.
    expect(recordUnitrustEvents(db, [ev('red')], later(3)).changed).toBe(0);
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

    recordUnitrustEvents(db, [ev('green', undefined, '2026-10-30')], later(10));
    expect(state(robert)).toMatchObject({ status: 'appointment_set', appt_result: 'sold' });
    recordUnitrustEvents(db, [ev('yellow', undefined, '2026-10-30')], later(11));
    expect(state(robert)).toMatchObject({ status: 'retry', appt_result: 'follow_up', appt_missed: 1 });
  });

  it('matches by phone, uses the name when leads share a number, and reports what it cannot match', () => {
    // Jane and John Doe share (614) 555-0101.
    const r = recordUnitrustEvents(db, [
      ev('blue', 'OH - ROCKET MORTG - JOHN DOE- (614) 555-0101 DOE'),
      ev('blue', 'OH - CHASE - NOBODY HERE- (999) 999-9999 HERE'),
      ev('blue', 'Dinner at vineyard'),
    ], later(1));
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
});
