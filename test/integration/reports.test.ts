import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, voidCall } from '../../src/server/domain/calls.js';
import { seedCountyAreaCodes } from '../../src/server/domain/areaCodes.js';
import { bestTimes, buildReport, drill, reportCalls, type ReportFilter } from '../../src/server/domain/reports.js';
import { setCalledBack } from '../../src/server/domain/callList.js';
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
    expect(b).toMatchObject({ sat: 0, sold: 0, close_rate: null, cost_per_sale: null });
    // An older "sold" outcome still counts as booked.
    const ben = log('Ben', 'no_answer');
    db.prepare("UPDATE call_outcome SET outcome_code = 'sold' WHERE call_id = ?").run(ben.call_id); // retired, so it can't be entered any more
    b = buildReport(db, range()).benchmarks.find((x) => x.key === 'B')!;
    expect(b).toMatchObject({ booked: 2 });
  });

  it('counts sales, close rate and cost per sale by lead type and batch, from how appointments went', () => {
    log('Amy', 'appt_sale');
    log('Dee', 'appt_sat_no_sale');
    log('Ben', 'appt_no_show');
    const r = buildReport(db, range());
    expect(r.benchmarks.find((x) => x.key === 'B')).toMatchObject({ sat: 1, sold: 1, close_rate: 1, cost_per_sale: 2100 });
    expect(r.benchmarks.find((x) => x.key === 'CI-A')).toMatchObject({ sat: 1, sold: 0, close_rate: 0, cost_per_sale: null });
    expect(r.by_batch[0]).toMatchObject({ sat: 2, sold: 1, close_rate: 0.5, cost_per_sale: 2100 + 6800 });
    // Drill-down shows the leads behind it.
    const leads = drill(db, range(), { section: 'benchmarks', key: 'B', metric: 'sold' });
    expect(leads.rows.map((l: any) => l.lead_name)).toEqual(['Amy One']);
  });

  it('breaks the numbers down by lead type', () => {
    const b = buildReport(db, range()).benchmarks.find((x) => x.key === 'B')!;
    // Amy, Ben and Cal: all called, Amy and Ben reached, Amy booked. Cal's spreadsheet call counts too (all time).
    expect(b).toMatchObject({ leads: 3, never_called: 0, dials: 6, attempts: 5, contacts: 2, appointments: 1, bad_numbers: 0, called_back: 0 });
    expect(b.dials_per_lead).toBe(2);
    expect(b.reached_rate).toBeCloseTo(2 / 3);
    expect(b.booked_rate).toBeCloseTo(1 / 3);
    expect(b.cost_per_reached).toBe(1050);
  });

  it('changes the lead type on every lead matching the filters, and the report follows', async () => {
    const setType = (payload: object) => app.inject({ method: 'POST', url: '/api/leads/set-type', headers: write, payload });
    const price = (code: string) => (db.prepare('SELECT price_cents FROM lead_type WHERE code = ?').get(code) as { price_cents: number | null }).price_cents;
    // Every B lead (the imported batch, minus the two CI-A ones) becomes D.
    expect((await setType({ lead_type: 'B', set_type: 'D' })).json()).toEqual({ changed: 3, matched: 3 });
    let r = buildReport(db, range());
    expect(r.benchmarks.find((x) => x.key === 'B')).toBeUndefined();
    expect(r.benchmarks.find((x) => x.key === 'D')).toMatchObject({ leads: 3, booked: 1, cost: 3 * (price('D') ?? 0) });
    expect(r.benchmarks.find((x) => x.key === 'CI-A')).toMatchObject({ leads: 2 });
    // The old type and price are kept in each lead's change history.
    expect(db.prepare("SELECT old_value, new_value FROM lead_change WHERE lead_id = ? AND field = 'lead_type'").all(id.Amy)).toEqual([{ old_value: 'B', new_value: 'D' }]);
    expect(db.prepare("SELECT old_value FROM lead_change WHERE lead_id = ? AND field = 'price_cents'").get(id.Amy)).toEqual({ old_value: '700' });

    // A whole batch, with leads already of that type left alone.
    const batch = (db.prepare('SELECT batch_id FROM lead LIMIT 1').get() as { batch_id: string }).batch_id;
    expect((await setType({ batch_id: batch, set_type: 'D' })).json()).toEqual({ changed: 2, matched: 5 });
    // Clearing the type, then finding those leads with the "no lead type" filter.
    expect((await setType({ search: 'Amy', set_type: null })).json()).toEqual({ changed: 1, matched: 1 });
    expect((await app.inject({ url: '/api/leads?lead_type=none', headers: auth })).json().rows.map((x: any) => x.first_name)).toEqual(['Amy']);
    r = buildReport(db, range());
    expect(r.benchmarks.find((x) => x.key === '')).toMatchObject({ label: 'No lead type', leads: 1, cost: 0 });

    expect((await setType({ set_type: 'NOPE' })).statusCode).toBe(400);
    expect((await setType({ lead_type: 'D' })).statusCode).toBe(400);
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
    for (const b of r.benchmarks) for (const m of ['leads', 'cost', 'never_called', 'dials', 'attempts', 'contacts', 'appointments', 'bad_numbers', 'called_back', 'reached', 'booked']) check('benchmarks', b.key, m, (b as any)[m]);
    for (const b of r.best_time) check('best_time', b.key, 'contacts', b.contacts);
    for (const c of r.by_caller) for (const m of ['dials', 'attempts', 'leads_called', 'contacts', 'appointments', 'callbacks']) check('by_caller', c.key, m, (c as any)[m]);
  });

  it('compares local and out-of-area caller ID', async () => {
    const local = (await app.inject({ method: 'POST', url: '/api/numbers', headers: write, payload: { number: '260-555-0198', label: 'Fort Wayne' } })).json().id;
    // 260 is local to Allen and DeKalb, out of area for Marion (317).
    log('Ben', 'appointment', { from_number_id: local, talk_seconds: 200 });
    log('Cal', 'no_answer', { from_number_id: local });
    log('Dee', 'no_answer', { from_number_id: local });
    // No caller ID recorded.
    logManualCall(db, { lead_id: id.Eve!, idempotency_key: uuidv7(), outcome_code: 'no_answer', occurred_at: hourAgo() } as any);
    const r = buildReport(db, range());
    expect(r.by_caller.map((c) => c.key)).toEqual(['local', 'out_of_area', 'unknown']);
    expect(r.by_caller[0]).toMatchObject({ attempts: 2, contacts: 1, appointments: 1, contact_rate: 0.5, appt_rate: 0.5, appts_per_contact: 1 });
    expect(r.by_caller[1]).toMatchObject({ attempts: 8, appointments: 2 });
    expect(r.by_caller[2]).toMatchObject({ attempts: 1, contacts: 0, contact_rate: 0 });

    // A call-back counts under the number you last called them from: Cal (DeKalb) last got the 260 number, local;
    // Dee (Marion, 317) got it too, which is out of area for her; Amy last got the 614 number.
    setCalledBack(db, id.Cal!, true);
    setCalledBack(db, id.Dee!, true);
    setCalledBack(db, id.Amy!, true);
    let back = buildReport(db, range()).by_caller;
    expect(back.map((c) => [c.key, c.called_back])).toEqual([['local', 1], ['out_of_area', 2], ['unknown', 0]]);
    expect(drill(db, range(), { section: 'by_caller', key: 'local', metric: 'called_back' }).rows.map((x: any) => x.lead_name).sort()).toEqual(['Cal Three']);
    setCalledBack(db, id.Amy!, false);
    back = buildReport(db, range()).by_caller;
    expect(back[1]!.called_back).toBe(1);
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

describe('report data export', () => {
  it('lists every call in the range, one row each, without health fields', () => {
    db.prepare("UPDATE lead SET tobacco_raw = 'yes', health_heart_raw = 'yes'").run();
    const rows = reportCalls(db, range());
    // 6 timed calls and the spreadsheet call; the undone call is left out.
    expect(rows).toHaveLength(7);
    expect(rows.filter((r) => r.time_known === 'no')).toHaveLength(1);
    expect(rows.find((r) => r.time_known === 'no')!.time).toBe('');
    const amy = rows.find((r) => r.lead_name === 'Amy One' && r.outcome_code === 'appointment')!;
    expect(amy).toMatchObject({
      lead_phone: '+12605550101', county: 'Allen', state: 'IN', lead_type: 'B', batch: 'October',
      caller_id: '+16145550199', caller_id_label: 'Sideline', caller_id_match: 'out_of_area',
      outcome: expect.any(String), contact: 'yes', talk_seconds: 300, time_known: 'yes',
    });
    expect(amy.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(amy.time).toMatch(/^\d{2}:\d{2}$/);
    expect(JSON.stringify(rows)).not.toMatch(/tobacco|health/);
  });

  it('serves the calls as CSV and the report as JSON, and adds a Calls sheet to Excel', async () => {
    const f = range();
    const q = `from=${encodeURIComponent(f.from)}&to=${encodeURIComponent(f.to)}&tz=America%2FIndiana%2FIndianapolis&area_codes=260`;
    const csv = await app.inject({ url: `/api/reports/calls.csv?${q}`, headers: auth });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('report-calls-');
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toMatch(/^call_id,date,time,time_known,called_at_utc,lead_id,lead_name,lead_phone,/);
    // Area code 260: Amy, Ben and Cal (Cal twice, once from the spreadsheet).
    expect(lines).toHaveLength(1 + 5);

    const j = await app.inject({ url: `/api/reports/export.json?${q}`, headers: auth });
    expect(j.statusCode).toBe(200);
    expect(j.headers['content-type']).toContain('application/json');
    const body = j.json();
    expect(body.summary.activity.leads_called).toBe(3);
    expect(body.calls).toHaveLength(5);
    expect(Object.keys(body.notes)).toContain('date_range');

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await app.inject({ url: `/api/reports/export.xlsx?${q}`, headers: auth })).rawPayload as any);
    expect(wb.getWorksheet('Calls')!.rowCount).toBe(1 + 5);

    const bad = await app.inject({ url: '/api/reports/calls.csv?from=nope&to=nope', headers: auth });
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

describe('lead age', () => {
  it('filters Leads by age band, shows on the call list, and reports calls by the lead\'s age when called', async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    db.prepare('UPDATE lead SET callin_at = ? WHERE id = ?').run(daysAgo(3), id.Amy);
    db.prepare('UPDATE lead SET callin_at = ? WHERE id = ?').run(daysAgo(45), id.Ben);
    const names = async (age: string) => (await app.inject({ url: `/api/leads?age=${age}`, headers: auth })).json().rows.map((r: any) => r.first_name).sort();
    expect(await names('0_7')).toEqual(['Amy']);
    expect(await names('31_90')).toEqual(['Ben']);
    expect(await names('unknown')).toEqual(['Cal', 'Dee', 'Eve']);
    expect((await app.inject({ url: '/api/leads?age=ancient', headers: auth })).statusCode).toBe(400);
    const r = buildReport(db, range());
    // Amy: 2 calls (a pickup and an appointment) at 3 days; Ben: 1 pickup at 45 days.
    expect(r.by_age.find((a) => a.key === '0_7')).toMatchObject({ attempts: 2, contacts: 1, appointments: 1 });
    expect(r.by_age.find((a) => a.key === '31_90')).toMatchObject({ attempts: 1, contacts: 1, appointments: 0 });
  });
});

describe('week by week', () => {
  it('puts this week next to the 4 before it, Monday to Sunday, with appts per pickup by lead type', () => {
    log('Ben', 'appointment', { occurred_at: new Date(Date.now() - 9 * 86_400_000).toISOString() });
    const w = buildReport(db, range()).weekly;
    expect(w.weeks).toHaveLength(5);
    expect(new Date(`${w.weeks[0]!.start}T12:00:00Z`).getUTCDay()).toBe(1);
    const starts = w.weeks.map((x) => x.start);
    expect(starts).toEqual(starts.slice().sort().reverse());
    // The setup's calls (pickups Amy, Ben, Dee, Eve; appointments Amy and Dee) and Ben's booking 9 days ago.
    const sum = (k: 'pickups' | 'appointments') => w.weeks.reduce((n, x) => n + x[k], 0);
    expect([sum('pickups'), sum('appointments')]).toEqual([5, 3]);
    expect(w.types.map((t) => t.key)).toEqual(['B', 'CI-A']);
    expect(w.weeks.reduce((n, x) => n + x.by_type['CI-A']!.appointments, 0)).toBe(1);
    expect(buildReport(db, range()).targets).toMatchObject({ show_rate: 0.8, close_rate: 0.5 });
  });
});

describe('best time first on the call list', () => {
  it('counts attempts and pickups by the lead\'s weekday and hour, and comes with the call list', async () => {
    const tz = 'America/Indiana/Indianapolis';
    const before = bestTimes(db, tz)['4:18'] ?? { attempts: 0, pickups: 0 };
    // 6 PM on a Thursday in Indiana (Eastern).
    log('Amy', 'no_answer', { occurred_at: '2026-10-22T22:10:00.000Z' });
    log('Ben', 'no_appt', { occurred_at: '2026-10-22T22:40:00.000Z' });
    expect(bestTimes(db, tz)['4:18']).toEqual({ attempts: before.attempts + 2, pickups: before.pickups + 1 });
    const r = (await app.inject({ url: `/api/call-list?tz=${tz}`, headers: auth })).json();
    expect(r.best_times['4:18']).toEqual({ attempts: before.attempts + 2, pickups: before.pickups + 1 });
    expect(r.items.every((i: any) => 'time_zone' in i)).toBe(true);
  });
});
