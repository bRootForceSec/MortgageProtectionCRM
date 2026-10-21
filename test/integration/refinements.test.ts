import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { tempDb, sampleCsv, dueLeads } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, voidCall, changeOutcome } from '../../src/server/domain/calls.js';
import { verifyLeadState } from '../../src/server/domain/leadState.js';
import { buildApp } from '../../src/server/http/app.js';
import { KdeConnect } from '../../src/server/dialer.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';
import { PDFDocument } from 'pdf-lib';
import { makeLeadPdf, FAKE } from '../pdfFixtures.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: 'http://127.0.0.1:5170' };
const key = () => `k-${uuidv7()}`;

let db: DB;
let app: FastifyInstance;
let jane: string;
let ran: string[][];
let importsDir: string;

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  importsDir = t.c.importsDir;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  jane = (db.prepare("SELECT id FROM lead WHERE first_name = 'Jane'").get() as any).id;
  ran = [];
  const kde = new KdeConnect(async (_cmd, args) => {
    ran.push(args);
    if (args[0] === '-l') return 'abc123 Pixel 8\n';
    if (args[0] === '-a') return 'abc123\n';
    return '';
  });
  app = await buildApp({ db, config: t.c, token: TOKEN, kde });
});

describe('dial counter', () => {
  it('stores the dials for one attempt and counts them in today\'s numbers', async () => {
    const r = await app.inject({
      method: 'POST', url: `/api/leads/${jane}/calls`, headers: write,
      payload: { idempotency_key: key(), outcome_code: 'no_answer', dial_count: 3 },
    });
    expect(r.statusCode).toBe(200);
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const s = (await app.inject({ url: `/api/stats/today?from=${from}&to=${to}`, headers: auth })).json();
    expect(s).toMatchObject({ attempts: 2, dials: 4 });
    // One attempt, however many dials.
    expect(db.prepare('SELECT attempts_total FROM lead_state WHERE lead_id = ?').get(jane)).toEqual({ attempts_total: 2 });
  });

  it("leaves out calls from a spreadsheet's history, which have no real time", async () => {
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', dial_count: 2 });
    const sheet = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    db.prepare("UPDATE call SET time_known = 0, history_source = 'sheet' WHERE id = ?").run(sheet.call_id);
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const s = (await app.inject({ url: `/api/stats/today?from=${from}&to=${to}`, headers: auth })).json();
    expect(s).toMatchObject({ attempts: 1, dials: 2 });
  });

  it('refuses zero dials', async () => {
    const r = await app.inject({
      method: 'POST', url: `/api/leads/${jane}/calls`, headers: write,
      payload: { idempotency_key: key(), outcome_code: 'no_answer', dial_count: 0 },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('undo', () => {
  it('voids the call, puts the lead back where it was, and returns what was entered', () => {
    const before = db.prepare('SELECT status, attempts_total FROM lead_state WHERE lead_id = ?').get(jane);
    const { call_id } = logManualCall(db, {
      lead_id: jane, idempotency_key: key(), outcome_code: 'appointment', dial_count: 2, note: 'wife home after 6',
    });
    expect(db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(jane)).toEqual({ status: 'appointment_set' });
    const back = voidCall(db, call_id);
    expect(back).toMatchObject({ outcome_code: 'appointment', dial_count: 2, note: 'wife home after 6' });
    expect(db.prepare('SELECT status, attempts_total FROM lead_state WHERE lead_id = ?').get(jane)).toEqual(before);
    // History stays.
    expect(db.prepare('SELECT voided_at IS NOT NULL v FROM call WHERE id = ?').get(call_id)).toEqual({ v: 1 });
    expect(verifyLeadState(db)).toEqual([]);
    expect(() => voidCall(db, call_id)).toThrow(/already undone/);
    expect(() => changeOutcome(db, call_id, { outcome_code: 'no_answer', expected_current_id: null })).toThrow(/undone/);
  });

  it('undone calls leave the stats, the notes list and the queue order', async () => {
    const { call_id } = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', note: 'x' });
    const r = await app.inject({ method: 'POST', url: `/api/calls/${call_id}/void`, headers: write, payload: {} });
    expect(r.statusCode).toBe(200);
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const s = (await app.inject({ url: `/api/stats/today?from=${from}&to=${to}`, headers: auth })).json();
    expect(s).toMatchObject({ attempts: 0, dials: 0 });
    const d = (await app.inject({ url: `/api/leads/${jane}`, headers: auth })).json();
    expect(d.notes).toEqual([]);
    expect(d.calls[0].voided_at).toBeTruthy();
    expect(dueLeads(db).find((l) => l.id === jane)?.status).toBe('new');
  });
});

describe('calling settings', () => {
  it('a new retry gap changes when unanswered leads come back', async () => {
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    expect(dueLeads(db).some((l) => l.id === jane)).toBe(false);
    const cur = (await app.inject({ url: '/api/settings/calling', headers: auth })).json();
    expect(cur.settings.retry_gap_minutes).toBe(240);
    const r = await app.inject({
      method: 'PUT', url: '/api/settings/calling', headers: write, payload: { ...cur.settings, retry_gap_minutes: 0 },
    });
    expect(r.statusCode).toBe(200);
    expect(dueLeads(db).find((l) => l.id === jane)?.status).toBe('retry');
  });

  it('keeps remapped shortcuts and refuses unknown actions', async () => {
    const cur = (await app.inject({ url: '/api/settings/calling', headers: auth })).json();
    const ok = await app.inject({
      method: 'PUT', url: '/api/settings/calling', headers: write,
      payload: { ...cur.settings, shortcuts: { actions: { next: ['j'] }, outcomes: { no_answer: 'q' } } },
    });
    expect(ok.json().settings.shortcuts).toEqual({ actions: { next: ['j'] }, outcomes: { no_answer: 'q' } });
    const bad = await app.inject({
      method: 'PUT', url: '/api/settings/calling', headers: write,
      payload: { ...cur.settings, shortcuts: { actions: { launch_rockets: ['x'] }, outcomes: {} } },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('dial from the computer', () => {
  it('lists phones and sends a tel: link to the chosen one, with no shell', async () => {
    const d = (await app.inject({ url: '/api/dial/devices', headers: auth })).json();
    expect(d.devices).toEqual([{ id: 'abc123', name: 'Pixel 8', reachable: true }]);
    const r = await app.inject({ method: 'POST', url: '/api/dial', headers: write, payload: { to_e164: '+16145550101', device_id: 'abc123' } });
    expect(r.statusCode).toBe(200);
    expect(ran.at(-1)).toEqual(['-d', 'abc123', '--share', 'tel:+16145550101']);
    const bad = await app.inject({ method: 'POST', url: '/api/dial', headers: write, payload: { to_e164: '+16145550101; rm -rf ~', device_id: 'abc123' } });
    expect(bad.statusCode).toBe(400);
  });

  it('says so when KDE Connect is missing', async () => {
    const t = tempDb();
    const none = await buildApp({ db: t.db, config: t.c, token: TOKEN, kde: new KdeConnect(undefined, 'kdeconnect-cli-not-here') });
    const d = (await none.inject({ url: '/api/dial/devices', headers: auth })).json();
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/not installed/);
  });
});

describe('agenda', () => {
  it('lists due callbacks', async () => {
    const soon = new Date(Date.now() + 3600_000).toISOString();
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'callback', callback_due_at: soon });
    const ann = (db.prepare("SELECT id FROM lead WHERE first_name = 'Ann'").get() as any).id;
    logManualCall(db, { lead_id: ann, idempotency_key: key(), outcome_code: 'appointment' });
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 86400_000).toISOString();
    const a = (await app.inject({ url: `/api/agenda?from=${from}&to=${to}`, headers: auth })).json();
    expect(a.callbacks.map((c: any) => c.lead_id)).toEqual([jane]);
    expect(a.appointments).toBeUndefined(); // appointments live in Unitrust
    expect(a.callbacks[0].time_zone).toBe('America/New_York');
  });
});

describe('editing a lead', () => {
  it('changes details, keeps the old values, and refuses a bad phone', async () => {
    const r = await app.inject({
      method: 'PATCH', url: `/api/leads/${jane}`, headers: write,
      payload: { details: { first_name: 'Janet', phone2: '(614) 555-0177', state: 'IN', loan_amount: '300k' } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ first_name: 'Janet', phone2_e164: '+16145550177', state: 'IN', time_zone: 'America/Indiana/Indianapolis', loan_amount_cents: 30000000 });
    const changes = db.prepare("SELECT field, old_value, new_value FROM lead_change WHERE lead_id = ? AND field = 'first_name'").all(jane);
    expect(changes).toEqual([{ field: 'first_name', old_value: 'Jane', new_value: 'Janet' }]);
    const bad = await app.inject({ method: 'PATCH', url: `/api/leads/${jane}`, headers: write, payload: { details: { phone: '555-01' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Phone/);
  });
});

describe('date of birth and the lead page', () => {
  it('a date of birth typed in sets the age from it', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/api/leads/${jane}`, headers: write, payload: { details: { dob: '3/14/1961', age: '20' } } });
    expect(r.statusCode).toBe(200);
    const lead = db.prepare('SELECT dob, dob_raw, age FROM lead WHERE id = ?').get(jane) as any;
    const now = new Date();
    const expected = now.getFullYear() - 1961 - (now.getMonth() < 2 || (now.getMonth() === 2 && now.getDate() < 14) ? 1 : 0);
    expect(lead).toEqual({ dob: '1961-03-14', dob_raw: '3/14/1961', age: expected });
    const bad = await app.inject({ method: 'PATCH', url: `/api/leads/${jane}`, headers: write, payload: { details: { dob: '2/30/1961' } } });
    expect(bad.statusCode).toBe(400);
  });

  it('a spreadsheet lead has no PDF page, but its imported row comes with it', async () => {
    const d = (await app.inject({ url: `/api/leads/${jane}`, headers: auth })).json();
    expect(d.source_pdf).toBe(false);
    expect(JSON.parse(d.import_row.raw_json)).toMatchObject({ 'Lead Name': 'Jane Doe', Lender: 'Rocket Mortgage' });
  });

  it("serves a batch's PDF, and only a PDF", async () => {
    const batch = (db.prepare('SELECT batch_id FROM lead WHERE id = ?').get(jane) as any).batch_id;
    fs.writeFileSync(path.join(importsDir, `${batch}-a.csv`), 'not a pdf');
    expect((await app.inject({ url: `/api/batches/${batch}/file`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/batches/..%2F..%2Fetc/file`, headers: auth })).statusCode).toBe(404);

    fs.writeFileSync(path.join(importsDir, `${batch}-Oct leads.pdf`), '%PDF-1.4 test');
    db.prepare('UPDATE lead SET source_page = 2 WHERE id = ?').run(jane);
    const r = await app.inject({ url: `/api/batches/${batch}/file`, headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.body).toBe('%PDF-1.4 test');
    expect((await app.inject({ url: `/api/batches/${batch}/file`, headers: { host: auth.host } })).statusCode).toBe(401);
    const d = (await app.inject({ url: `/api/leads/${jane}`, headers: auth })).json();
    expect(d.source_pdf).toBe(true);
    expect(d.lead.source_page).toBe(2);
  });

  it('"Keep this way" saves a turn of the lead\'s page into the batch PDF', async () => {
    const batch = (db.prepare('SELECT batch_id FROM lead WHERE id = ?').get(jane) as any).batch_id;
    for (const f of fs.readdirSync(importsDir)) if (f.startsWith(`${batch}-`)) fs.rmSync(path.join(importsDir, f));
    const turn = (body: unknown) => app.inject({ method: 'POST', url: `/api/leads/${jane}/page-turn`, headers: write, payload: body as object });
    expect((await turn({ turn: 90 })).statusCode).toBe(404); // no PDF kept
    const file = path.join(importsDir, `${batch}-Oct leads.pdf`);
    fs.writeFileSync(file, await makeLeadPdf([FAKE[0]!, FAKE[0]!]));
    db.prepare('UPDATE lead SET source_page = 2 WHERE id = ?').run(jane);
    expect((await turn({ turn: 'x' })).statusCode).toBe(400);
    const r = await turn({ turn: 270 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ turned: 1 });
    const doc = await PDFDocument.load(fs.readFileSync(file));
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 270]);
  });
});
