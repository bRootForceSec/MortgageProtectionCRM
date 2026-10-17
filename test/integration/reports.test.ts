import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, voidCall } from '../../src/server/domain/calls.js';
import { seedCountyAreaCodes } from '../../src/server/domain/areaCodes.js';
import { buildReport, drill, type ReportFilter } from '../../src/server/domain/reports.js';
import { buildApp } from '../../src/server/http/app.js';
import { createBackup, checkLatestBackup, listBackups } from '../../src/server/backup.js';
import type { DB } from '../../src/server/db/connection.js';
import type { Config } from '../../src/server/config.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: 'http://127.0.0.1:5170' };

let db: DB;
let config: Config;
let app: FastifyInstance;
let id: Record<string, string>;
let numberId: string;

// Synthetic leads only.
const HEADERS = ['Lead Name', 'Phone', 'City', 'State', 'Zip', 'County'];
const ROWS = [
  ['Amy One', '(260) 555-0101', 'Fort Wayne', 'IN', '46802', 'Allen'],
  ['Ben Two', '(260) 555-0102', 'Fort Wayne', 'IN', '46802', 'Allen'],
  ['Cal Three', '(260) 555-0103', 'Auburn', 'IN', '46706', 'DeKalb'],
  ['Dee Four', '(317) 555-0104', 'Indianapolis', 'IN', '46204', 'Marion'],
  ['Eve Five', '(317) 555-0105', 'Indianapolis', 'IN', '46204', 'Marion'],
];
const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();
const range = (): ReportFilter => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString(), tz: 'America/Indiana/Indianapolis' });
const log = (lead: string, outcome: string, extra: Record<string, unknown> = {}) =>
  logManualCall(db, { lead_id: id[lead]!, idempotency_key: uuidv7(), outcome_code: outcome, from_number_id: numberId, occurred_at: hourAgo(), ...extra } as any);

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  config = t.c;
  const parsed = await parseSpreadsheet(sampleCsv(ROWS, HEADERS), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'October' });
  id = Object.fromEntries((db.prepare('SELECT id, first_name FROM lead').all() as any[]).map((r) => [r.first_name, r.id]));
  db.prepare("UPDATE lead SET lead_type = 'B', price_cents = 700").run();
  db.prepare("UPDATE lead SET lead_type = 'CI-A', price_cents = 3400 WHERE first_name IN ('Dee','Eve')").run();
  seedCountyAreaCodes(db);
  app = await buildApp({ db, config, token: TOKEN });
  numberId = (await app.inject({ method: 'POST', url: '/api/numbers', headers: write, payload: { number: '614-555-0199', label: 'Sideline' } })).json().id;

  log('Amy', 'no_answer', { dial_count: 2 });
  log('Amy', 'appointment', { talk_seconds: 300 });
  log('Ben', 'no_appt', { talk_seconds: 60 });
  log('Cal', 'no_answer');
  log('Dee', 'appointment', { talk_seconds: 400 });
  log('Eve', 'callback', { talk_seconds: 30, callback_due_at: new Date(Date.now() + 7200_000).toISOString() });
  // An undone call counts nowhere.
  const undone = log('Eve', 'appointment');
  voidCall(db, undone.call_id);
  // A call recreated from a spreadsheet: no real time.
  const sheetCall = log('Cal', 'no_answer');
  db.prepare("UPDATE call SET time_known = 0, history_source = 'sheet' WHERE id = ?").run(sheetCall.call_id);
});

describe('reports', () => {
  it('counts activity, leaving out undone calls and calls with no real time', () => {
    const r = buildReport(db, range());
    expect(r.activity).toMatchObject({
      attempts: 6, dials: 7, leads_called: 5, contacts: 4, conversations: 2, talk_minutes: 13, appointments: 2, callbacks: 1, bad_numbers: 0, untimed_calls: 1,
    });
    expect(r.by_hour.reduce((n, h) => n + h.dials, 0)).toBe(7);
  });

  it('groups by county with the county area codes, including spreadsheet calls', () => {
    const r = buildReport(db, range());
    const allen = r.by_county.find((c) => c.key === 'IN|ALLEN')!;
    expect(allen).toMatchObject({ leads: 2, attempts: 3, dials: 4, contacts: 2, appointments: 1, area_codes: '260' });
    expect(r.by_county.find((c) => c.key === 'IN|DEKALB')).toMatchObject({ attempts: 2 });
  });

  it('follows the county and area-code filter', () => {
    const r = buildReport(db, { ...range(), areaCodes: ['317'] });
    expect(r.activity.leads_called).toBe(2);
    expect(r.by_batch[0]).toMatchObject({ leads: 2, cost: 6800 });
  });

  it('tracks booked against the targets, with cost per result', () => {
    let b = buildReport(db, range()).benchmarks.find((x) => x.key === 'B')!;
    expect(b).toMatchObject({ leads: 3, reached: 2, booked: 1, booked_per_reached: 0.5, booked_target: 0.2, cost: 2100, cost_per_booked: 2100 });
    expect(b).not.toHaveProperty('sat');
    expect(b).not.toHaveProperty('sold');
    // An older "sold" outcome still counts as booked.
    const ben = log('Ben', 'no_answer');
    db.prepare("UPDATE call_outcome SET outcome_code = 'sold' WHERE call_id = ?").run(ben.call_id); // retired, so it can't be entered any more
    b = buildReport(db, range()).benchmarks.find((x) => x.key === 'B')!;
    expect(b).toMatchObject({ booked: 2 });
  });

  it('every number matches the rows behind it', () => {
    const f = range();
    const r = buildReport(db, f);
    const check = (section: any, key: string, metric: string, value: number) => {
      const d = drill(db, f, { section, key, metric });
      const got = metric === 'dials' ? d.rows.reduce((n: number, x: any) => n + (x.dials ?? 0), 0)
        : metric === 'talk_minutes' ? Math.round(d.rows.reduce((n: number, x: any) => n + (x.talk_seconds ?? 0), 0) / 60)
          : metric === 'cost' ? d.rows.reduce((n: number, x: any) => n + (x.price_cents ?? 0), 0)
            : d.rows.length;
      expect(got, `${section} ${key} ${metric}`).toBe(value);
    };
    for (const m of ['attempts', 'dials', 'leads_called', 'contacts', 'conversations', 'talk_minutes', 'appointments', 'callbacks', 'bad_numbers']) {
      check('activity', 'all', m, (r.activity as any)[m]);
    }
    for (const h of r.by_hour) for (const m of ['dials', 'attempts', 'contacts', 'appointments']) check('by_hour', String(h.hour), m, (h as any)[m]);
    for (const c of r.by_county) for (const m of ['leads', 'dials', 'attempts', 'contacts', 'appointments']) check('by_county', c.key, m, (c as any)[m]);
    for (const b of r.by_batch) for (const m of ['leads', 'cost', 'never_called', 'dials', 'reached', 'booked']) check('by_batch', b.key, m, (b as any)[m]);
    for (const b of r.benchmarks) for (const m of ['leads', 'reached', 'booked']) check('benchmarks', b.key, m, (b as any)[m]);
    for (const b of r.best_time) check('best_time', b.key, 'contacts', b.contacts);
  });

  it('serves the report, drill-down, Excel export and editable targets over HTTP', async () => {
    const f = range();
    const q = `from=${encodeURIComponent(f.from)}&to=${encodeURIComponent(f.to)}&tz=America%2FIndiana%2FIndianapolis&area_codes=260`;
    const r = (await app.inject({ url: `/api/reports?${q}`, headers: auth })).json();
    expect(r.activity.leads_called).toBe(3);
    const d = (await app.inject({ url: `/api/reports/drill?${q}&section=activity&metric=contacts`, headers: auth })).json();
    expect(d.kind).toBe('calls');
    expect(d.rows.map((x: any) => x.lead_name).sort()).toEqual(['Amy One', 'Ben Two']);
    const x = await app.inject({ url: `/api/reports/export.xlsx?${q}`, headers: auth });
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const t = await app.inject({ method: 'PUT', url: '/api/reports/targets', headers: write, payload: { booked_per_contact: { B: 0.3 } } });
    expect(t.statusCode).toBe(200);
    expect(buildReport(db, f).benchmarks.find((b) => b.key === 'B')!.booked_target).toBe(0.3);
    const bad = await app.inject({ method: 'PUT', url: '/api/reports/targets', headers: write, payload: { booked_per_contact: { B: 3 } } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('caller ID numbers', () => {
  it('shows calls, dials, pick-up rate and appointments set', async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const s = (await app.inject({ url: `/api/numbers/stats?today_from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`, headers: auth })).json();
    expect(s[0]).toMatchObject({ calls_7d: 6, dials_7d: 7, contacts_7d: 4, appointments: 2 });
    expect(s[0]).not.toHaveProperty('open_appointments');
    expect(s[0].contact_rate_7d).toBeCloseTo(4 / 6);
  });

  it('keeps a reputation checklist, newest entry per item', async () => {
    const post = (payload: object) => app.inject({ method: 'POST', url: `/api/numbers/${numberId}/checks`, headers: write, payload });
    expect((await post({ item: 'cnam', checked_on: '2026-10-01', result: 'ok' })).statusCode).toBe(200);
    const after = (await post({ item: 'cnam', checked_on: '2026-10-15', result: 'problem', note: 'shows Spam Risk' })).json();
    expect(after.find((c: any) => c.item === 'cnam')).toMatchObject({ checked_on: '2026-10-15', result: 'problem', note: 'shows Spam Risk' });
    expect((await post({ item: 'made_up', checked_on: null })).statusCode).toBe(400);
    expect(db.prepare('SELECT count(*) n FROM caller_number_check').get()).toEqual({ n: 2 });
  });
});

describe('backup restore check', () => {
  it('restores the newest backup into a scratch copy and notices a bad one', async () => {
    expect(checkLatestBackup(config).ok).toBeNull();
    await createBackup(db, config);
    const ok = checkLatestBackup(config);
    expect(ok.ok).toBe(true);
    const file = listBackups(config).at(-1)!;
    const meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
    meta.counts.lead = 999;
    fs.writeFileSync(`${file}.json`, JSON.stringify(meta));
    const bad = checkLatestBackup(config);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('lead');
    // Nothing is left behind.
    expect(fs.readdirSync(config.backupDir).filter((f) => f.startsWith('.check-'))).toEqual([]);
    const r = (await app.inject({ method: 'POST', url: '/api/backups/check', headers: write, payload: {} })).json();
    expect(r.ok).toBe(false);
    expect((await app.inject({ url: '/api/backups/check', headers: auth })).json().ok).toBe(false);
  });
});
