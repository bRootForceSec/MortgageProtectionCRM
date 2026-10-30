import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { recordUnitrustEvents, type UnitrustEvent } from '../../src/server/domain/unitrustAppointments.js';
import { verifyLeadState } from '../../src/server/domain/leadState.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';
import type { Config } from '../../src/server/config.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
let db: DB;
let config: Config;
const id = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const apptLead = () => (db.prepare("SELECT lead_id FROM appointment WHERE recorded_via = 'unitrust'").all() as { lead_id: string }[]).map((r) => r.lead_id);
const ev = (title: string, lead_id?: string): UnitrustEvent => ({ title, date: '2026-10-26', time: '10:00', color: 'blue', lead_id });

beforeEach(async () => {
  ({ db, c: config } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
});

describe('opening a lead link', () => {
  it('in a browser, it needs no cookie and goes on to the app on that lead', async () => {
    const app = await buildApp({ db, config, token: TOKEN });
    const ann = id('Ann');
    const r = await app.inject({ url: `/lead/${ann}`, headers: { host: '127.0.0.1:5170' } });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/#lead/${ann}`);
    // Says nothing about the lead.
    expect(r.body).not.toContain('Ann');
  });

  it('in the desktop app, it brings the window up on that lead', async () => {
    const opened: string[] = [];
    const app = await buildApp({ db, config, token: TOKEN, openLead: (leadId) => opened.push(leadId) });
    const ann = id('Ann');
    const r = await app.inject({ url: `/lead/${ann}`, headers: { host: '127.0.0.1:5170' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('You can close this tab');
    expect(opened).toEqual([ann]);
  });

  it('a lead that is not here, or something that is not a link, opens nothing', async () => {
    const opened: string[] = [];
    const app = await buildApp({ db, config, token: TOKEN, openLead: (leadId) => opened.push(leadId) });
    const missing = await app.inject({ url: '/lead/019a1f2e-3b4c-7d5e-8f60-123456789abc', headers: { host: '127.0.0.1:5170' } });
    expect(missing.statusCode).toBe(404);
    expect((await app.inject({ url: '/lead/not-a-lead', headers: { host: '127.0.0.1:5170' } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/lead/${id('Ann')}`, headers: { host: 'evil.example:5170' } })).statusCode).toBe(421);
    expect(opened).toEqual([]);
  });
});

describe('a lead link pasted into a Unitrust appointment', () => {
  it('matches the appointment to that lead, even when the phone in the title is wrong', () => {
    const ann = id('Ann');
    const r = recordUnitrustEvents(db, [ev('OH - CHASE - ANNIE LEE- (999) 999-9999 LEE', ann)]);
    expect(r).toMatchObject({ matched: 1, unmatched: [] });
    expect(apptLead()).toEqual([ann]);
    expect(verifyLeadState(db)).toEqual([]);
  });

  it('moves an appointment that phone matching put on the wrong lead', () => {
    const title = 'OH - ROCKET MORTG - ROBERT RAY- (614) 555-0102 RAY';
    recordUnitrustEvents(db, [ev(title)]);
    expect(apptLead()).toEqual([id('Robert')]);
    recordUnitrustEvents(db, [ev(title, id('Ann'))]);
    expect(apptLead()).toEqual([id('Ann')]);
    expect(verifyLeadState(db)).toEqual([]);
  });

  it('a link to a lead that is not here falls back to the phone', () => {
    recordUnitrustEvents(db, [ev('OH - ROCKET MORTG - ROBERT RAY- (614) 555-0102 RAY', '019a1f2e-3b4c-7d5e-8f60-123456789abc')]);
    expect(apptLead()).toEqual([id('Robert')]);
  });
});
