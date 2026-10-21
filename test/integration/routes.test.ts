// Characterization tests: they pin what these routes do today, so moving their code (PLAN.md C3) can't change it unnoticed.
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/http/app.js';
import { tempDb, sampleCsv, sampleXlsx } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { addToCallList, getCallList } from '../../src/server/domain/callList.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: 'http://127.0.0.1:5170' };

let app: FastifyInstance;
let db: DB;
let batch: string;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const get = (url: string) => app.inject({ url, headers: auth });
const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: write, payload: payload as any });
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: write, payload: payload as any });
const audits = (table: string) => db.prepare('SELECT * FROM audit_log WHERE table_name = ? ORDER BY at').all(table) as any[];

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  batch = commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' }).batchId;
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('lead routes', () => {
  it('notes: adds a note to the lead and shows it on the lead', async () => {
    const id = lead('Jane');
    const r = await post(`/api/leads/${id}/notes`, { body: 'call after 5' });
    expect(r.statusCode).toBe(200);
    const detail = (await get(`/api/leads/${id}`)).json();
    expect(detail.notes.map((n: any) => n.body)).toEqual(['call after 5']);
  });

  it('actions: mark dead, then restore', async () => {
    const id = lead('Robert');
    expect((await post(`/api/leads/${id}/actions`, { action: 'mark_dead', reason: 'test' })).statusCode).toBe(200);
    expect((await get(`/api/leads/${id}`)).json().state.status).toBe('dead');
    expect((await post(`/api/leads/${id}/actions`, { action: 'restore' })).statusCode).toBe(200);
    expect((await get(`/api/leads/${id}`)).json().state.status).not.toBe('dead');
    expect((await post(`/api/leads/${id}/actions`, { action: 'nonsense' })).statusCode).toBe(400);
  });

  it('called-back: sets and clears the mark; unknown lead is 404', async () => {
    const id = lead('Ann');
    const on = (await post(`/api/leads/${id}/called-back`, { on: true })).json();
    expect(typeof on.called_back_at).toBe('string');
    expect((await get(`/api/leads/${id}`)).json().called_back_at).toBe(on.called_back_at);
    expect((await post(`/api/leads/${id}/called-back`, { on: false })).json()).toEqual({ called_back_at: null });
    const missing = await post('/api/leads/nope/called-back', { on: true });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'lead not found' });
  });

  it('calls/:id/outcomes: changes the outcome, and refuses a stale expected id', async () => {
    const id = lead('Jane');
    const { call_id } = logManualCall(db, { lead_id: id, idempotency_key: `k-${uuidv7()}`, outcome_code: 'no_answer' });
    const cur = (db.prepare('SELECT id FROM call_outcome WHERE call_id = ?').get(call_id) as { id: string }).id;
    const r = await post(`/api/calls/${call_id}/outcomes`, { outcome_code: 'no_appt', expected_current_id: cur });
    expect(r.statusCode).toBe(200);
    const call = (await get(`/api/leads/${id}`)).json().calls[0];
    expect(call.current_outcome.outcome_code).toBe('no_appt');
    const stale = await post(`/api/calls/${call_id}/outcomes`, { outcome_code: 'no_answer', expected_current_id: cur });
    expect(stale.statusCode).toBeGreaterThanOrEqual(400);
    expect(stale.statusCode).toBeLessThan(500);
  });

  it('lead-links: resolves a suggested link and audits it; unknown link is 404', async () => {
    const link = db.prepare('SELECT * FROM lead_link').get() as any;
    expect(link.status).toBe('suggested');
    expect((await post(`/api/lead-links/${link.id}`, { status: 'same_person' })).json()).toEqual({ ok: true });
    const after = db.prepare('SELECT * FROM lead_link WHERE id = ?').get(link.id) as any;
    expect(after.status).toBe('same_person');
    expect(after.resolved_at).toBeTruthy();
    expect(audits('lead_link')).toHaveLength(1);
    await post(`/api/lead-links/${link.id}`, { status: 'suggested' });
    expect((db.prepare('SELECT resolved_at FROM lead_link WHERE id = ?').get(link.id) as any).resolved_at).toBeNull();
    expect((await post('/api/lead-links/nope', { status: 'same_person' })).statusCode).toBe(404);
  });
});

describe('call list routes', () => {
  it('skip moves a lead to the bottom; a lead not on the list is 404', async () => {
    const [a, b] = [lead('Jane'), lead('Robert')];
    addToCallList(db, [a, b]);
    expect((await post(`/api/call-list/${a}/skip`)).json()).toEqual({ ok: true });
    expect(getCallList(db).map((i) => i.lead_id)).toEqual([b, a]);
    expect((await post(`/api/call-list/${lead('Ann')}/skip`)).statusCode).toBe(404);
  });

  it('clear-worked removes leads that have been called', async () => {
    const [a, b] = [lead('Jane'), lead('Robert')];
    addToCallList(db, [a, b], new Date(Date.now() - 1000).toISOString());
    logManualCall(db, { lead_id: a, idempotency_key: `k-${uuidv7()}`, outcome_code: 'no_answer' });
    expect((await post('/api/call-list/clear-worked')).json()).toEqual({ removed: 1 });
    expect(getCallList(db).map((i) => i.lead_id)).toEqual([b]);
  });

  it('delete saved list', async () => {
    addToCallList(db, [lead('Jane')]);
    await post('/api/call-list/clear', { save_as: 'Monday' });
    const saved = (await get('/api/call-list')).json().saved_lists;
    expect(saved).toHaveLength(1);
    const r = await app.inject({ method: 'DELETE', url: `/api/saved-lists/${saved[0].id}`, headers: write });
    expect(r.json()).toEqual({ ok: true });
    expect((await get('/api/call-list')).json().saved_lists).toEqual([]);
  });
});

describe('import history routes', () => {
  it('lists batches with row counts', async () => {
    const rows = (await get('/api/imports')).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: batch, name: 'b1', rows_total: 7, rows_accepted: 4, rows_rejected: 2, rows_repeat: 1 });
  });

  it('problems.csv lists every row that was not imported, with its reasons and original columns', async () => {
    const r = await get(`/api/imports/${batch}/problems.csv`);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="import-problems-${batch}.csv"`);
    const lines = r.body.trim().split('\r\n');
    expect(lines[0]!.startsWith('row_number,status,problems,')).toBe(true);
    expect(lines).toHaveLength(4);
    expect(r.body).toContain('No Phone Person');
    expect(r.body).toContain('Bad Phone');
  });
});

describe('spreadsheet draft over HTTP', () => {
  it('upload → draft → review → type → settings → commit, and import-defaults remembers the type', async () => {
    expect((await get('/api/import-defaults')).json()).toEqual({ lead_type: 'D' });
    const parse = (await app.inject({
      method: 'POST', url: '/api/imports/parse', headers: { ...write, 'content-type': 'application/octet-stream', 'x-file-name': 'new.xlsx' },
      payload: await sampleXlsx([['Zed Zee', '(740) 555-0111', 'Chase', '100000', 50, '', '1 A St', 'Athens', 'OH', '45701', 'No', 'No', 'No', 'No', 'No', '']]),
    })).json();
    const sheet = parse.sheets[0];
    const draft = await post('/api/drafts/sheet', { upload_id: parse.upload_id, sheet: sheet.name, mapping: sheet.suggested_mapping });
    expect(draft.statusCode).toBe(200);
    const { id } = draft.json();

    expect((await get('/api/drafts')).json().map((d: any) => d.id)).toContain(id);
    const view = (await get(`/api/drafts/${id}`)).json();
    expect(view.reading_now).toBe(false);
    expect(view.rows).toHaveLength(1);
    const file = await get(`/api/drafts/${id}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['cache-control']).toBe('no-store');

    const row = view.rows[0].row_number;
    expect((await post(`/api/drafts/${id}/rows/${row}`, { action: 'ok' })).statusCode).toBe(200);
    expect((await post(`/api/drafts/${id}/type`, { lead_type: 'B', all: true })).statusCode).toBe(200);
    expect((await post(`/api/drafts/${id}/settings`, { default_lead_type: 'B' })).statusCode).toBe(200);
    expect((await post(`/api/drafts/${id}/retry`)).statusCode).toBe(200);

    const commit = await post(`/api/drafts/${id}/commit`, { batch: { name: 'HTTP sheet' }, add_to_call_list: true });
    expect(commit.statusCode).toBe(200);
    const c = commit.json();
    expect(c.summary).toMatchObject({ accepted: 1 });
    expect(c.call_list).toMatchObject({ added: 1 });
    expect((db.prepare('SELECT lead_type FROM lead WHERE first_name = ?').get('Zed') as any).lead_type).toBe('B');
    expect((await get('/api/import-defaults')).json()).toEqual({ lead_type: 'B' });
    expect((await post(`/api/drafts/${id}/commit`, { batch: { name: 'again' } })).statusCode).toBe(400);
    expect((await get(`/api/drafts/${id}/file`)).statusCode).toBe(404);
  });
});

describe('settings routes', () => {
  it('lead types: list, add, update, and every change is audited', async () => {
    const before = (await get('/api/lead-types')).json();
    expect(before.length).toBeGreaterThan(0);
    expect((await put('/api/lead-types/NEW', { price_cents: 100 })).statusCode).toBe(400);
    const added = (await put('/api/lead-types/NEW', { label: 'New kind', price_cents: 1500 })).json();
    expect(added).toMatchObject({ code: 'NEW', label: 'New kind', price_cents: 1500, active: 1 });
    expect(added.sort_order).toBe(Math.max(...before.map((t: any) => t.sort_order)) + 10);
    const updated = (await put('/api/lead-types/NEW', { active: false })).json();
    expect(updated).toMatchObject({ label: 'New kind', price_cents: 1500, active: 0 });
    expect(audits('lead_type').map((a) => a.action)).toEqual(['insert', 'update']);
  });

  it('county area codes: replaces the set and audits the old and new values', async () => {
    const key = 'OH|franklin';
    expect((await put('/api/counties/area-codes', { county_key: key, area_codes: ['614', '380'] })).json()).toEqual({ ok: true });
    expect((await put('/api/counties/area-codes', { county_key: key, area_codes: ['614'] })).json()).toEqual({ ok: true });
    const codes = db.prepare('SELECT area_code FROM county_area_code WHERE county_key = ?').all(key).map((r: any) => r.area_code);
    expect(codes).toEqual(['614']);
    const last = audits('county_area_code').at(-1);
    expect(JSON.parse(last.old_json).sort()).toEqual(['380', '614']);
    expect(JSON.parse(last.new_json)).toEqual(['614']);
    expect((await put('/api/counties/area-codes', { county_key: key, area_codes: ['61'] })).statusCode).toBe(400);
  });

  it('lead-pages/check reports the page checker state', async () => {
    const r = await get('/api/lead-pages/check');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveProperty('running');
  });

  it('settings/ai/test says reading is off when no provider is set', async () => {
    const r = (await post('/api/settings/ai/test')).json();
    expect(r).toHaveProperty('ok');
    expect(typeof r.message).toBe('string');
  });
});

describe('caller ID number routes', () => {
  it('adds, refuses a repeat, updates label, status and reputation, and audits each change', async () => {
    const { id } = (await post('/api/numbers', { number: '(614) 555-0199', label: '  Sideline  ' })).json();
    expect((await post('/api/numbers', { number: '614-555-0199' })).statusCode).toBe(409);
    const one = () => (get('/api/numbers')).then((r) => r.json().find((n: any) => n.id === id));
    expect(await one()).toMatchObject({ e164: '+16145550199', label: 'Sideline', status: 'active', retired_at: null });

    expect((await post(`/api/numbers/${id}`, { status: 'retired', retire_reason: 'spam label' })).json()).toEqual({ ok: true });
    const retired = await one();
    expect(retired).toMatchObject({ status: 'retired', retire_reason: 'spam label', label: 'Sideline' });
    expect(retired.retired_at).toBeTruthy();
    await post(`/api/numbers/${id}`, { status: 'active', label: '', reputation_status: 'flagged' });
    const back = await one();
    expect(back).toMatchObject({ status: 'active', retired_at: null, label: null, reputation_status: 'flagged', retire_reason: 'spam label' });
    expect(back.reputation_updated_at).toBeTruthy();
    expect(audits('caller_number').map((a) => a.action)).toEqual(['insert', 'update', 'update']);
    expect((await post('/api/numbers/nope', { label: 'x' })).statusCode).toBe(404);
  });
});

describe('backup routes', () => {
  it('makes a backup and lists it', async () => {
    const made = (await post('/api/backups')).json();
    expect(made).toMatchObject({ encrypted: false });
    expect(made.bytes).toBeGreaterThan(0);
    const list = (await get('/api/backups')).json();
    expect(list.map((b: any) => b.file)).toEqual([made.file]);
  });
});
