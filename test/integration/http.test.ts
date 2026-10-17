import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/http/app.js';
import { Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Updates } from '../../src/server/updates.js';
import { tempDb, sampleXlsx } from '../helpers.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const HOST = '127.0.0.1:5170';
const ORIGIN = 'http://127.0.0.1:5170';
const auth = { host: HOST, cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: ORIGIN };

let app: FastifyInstance;

beforeEach(async () => {
  const { db, c } = tempDb();
  app = await buildApp({ db, config: c, token: TOKEN });
});

describe('local access protections', () => {
  it('rejects requests with a foreign Host header (DNS rebinding)', async () => {
    const r = await app.inject({ url: '/api/meta', headers: { ...auth, host: 'evil.example:5170' } });
    expect(r.statusCode).toBe(421);
  });

  it('requires the access cookie on the API', async () => {
    const r = await app.inject({ url: '/api/meta', headers: { host: HOST } });
    expect(r.statusCode).toBe(401);
  });

  it('launch link sets an HttpOnly SameSite cookie and redirects without the token', async () => {
    const r = await app.inject({ url: `/?t=${TOKEN}`, headers: { host: HOST } });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/');
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    const bad = await app.inject({ url: '/?t=wrong', headers: { host: HOST } });
    expect(bad.statusCode).toBe(403);
  });

  it('blocks cross-origin writes', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/numbers', headers: { ...auth, origin: 'http://evil.example' }, payload: { number: '6145550199' } });
    expect(r.statusCode).toBe(403);
    const none = await app.inject({ method: 'POST', url: '/api/numbers', headers: auth, payload: { number: '6145550199' } });
    expect(none.statusCode).toBe(403);
  });

  it('sets a strict content security policy', async () => {
    const r = await app.inject({ url: '/api/meta', headers: auth });
    expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/);
  });
});

describe('import and work a lead over HTTP', () => {
  it('parse → preview → commit → queue → log call → export without health columns', async () => {
    // One buffer for both uploads: a regenerated workbook carries a new timestamp, so it would be a different file.
    const xlsxFile = await sampleXlsx();
    const parse = await app.inject({
      method: 'POST', url: '/api/imports/parse', headers: { ...write, 'content-type': 'application/octet-stream', 'x-file-name': 'leads.xlsx' },
      payload: xlsxFile,
    });
    expect(parse.statusCode).toBe(200);
    const p = parse.json();
    const sheet = p.sheets[0];
    expect(sheet.mapping_source).toBe('guessed');
    const body = { upload_id: p.upload_id, sheet: sheet.name, mapping: sheet.suggested_mapping };

    const prev = await app.inject({ method: 'POST', url: '/api/imports/preview', headers: write, payload: body });
    expect(prev.json().summary).toMatchObject({ accepted: 4, rejected: 2 });

    const commit = await app.inject({ method: 'POST', url: '/api/imports/commit', headers: write, payload: { ...body, batch: { name: 'Oct batch', cost_total_cents: 20000 } } });
    expect(commit.statusCode).toBe(200);

    // The mapping is remembered for the next file with the same columns.
    const again = await app.inject({
      method: 'POST', url: '/api/imports/parse', headers: { ...write, 'content-type': 'application/octet-stream', 'x-file-name': 'leads2.xlsx' },
      payload: xlsxFile,
    });
    expect(again.json().sheets[0].mapping_source).toBe('saved');
    expect(again.json().file_previously_imported).toHaveLength(1);

    const q = (await app.inject({ url: '/api/queue', headers: auth })).json();
    expect(q.counts.new).toBe(4);
    const leadId = q.items[0].lead_id;

    const num = (await app.inject({ method: 'POST', url: '/api/numbers', headers: write, payload: { number: '(614) 555-0199', label: 'Sideline' } })).json();
    const log = await app.inject({
      method: 'POST', url: `/api/leads/${leadId}/calls`, headers: write,
      payload: { idempotency_key: 'abc-12345678', outcome_code: 'vm_left', from_number_id: num.id, note: 'left VM' },
    });
    expect(log.statusCode).toBe(200);

    const detail = (await app.inject({ url: `/api/leads/${leadId}`, headers: auth })).json();
    expect(detail.calls).toHaveLength(1);
    expect(detail.calls[0].current_outcome.outcome_code).toBe('vm_left');
    expect(detail.calls[0].from_label).toBe('Sideline');
    expect(detail.notes[0].body).toBe('left VM');

    const csv = (await app.inject({ url: '/api/export/leads.csv', headers: auth })).body;
    expect(csv.split('\r\n')[0]).not.toMatch(/health|tobacco/);
    const withHealth = (await app.inject({ url: '/api/export/leads.csv?health=1', headers: auth })).body;
    expect(withHealth.split('\r\n')[0]).toMatch(/health_diabetes_raw/);

    const xlsx = await app.inject({ url: '/api/export/all.xlsx', headers: auth });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('returns readable validation errors', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/numbers', headers: write, payload: { number: '12' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/not 10 digits/);
  });
});

describe('logging', () => {
  it('T16: request logs never contain the access token, cookies, or lead data', async () => {
    let out = '';
    const stream = new Writable({ write(chunk, _enc, cb) { out += chunk; cb(); } });
    const { db, c } = tempDb();
    const logged = await buildApp({ db, config: c, token: TOKEN, logger: true, logStream: stream });
    await logged.inject({ url: `/?t=${TOKEN}`, headers: { host: HOST } });
    await logged.inject({ method: 'POST', url: '/api/numbers', headers: write, payload: { number: '(614) 555-0199', label: 'Sideline' } });
    await logged.inject({ url: '/api/leads?search=Jane%20Doe', headers: auth });
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('6145550199');
    expect(out).not.toContain('Jane');
    expect(out).not.toMatch(/cookie/i);
  });
});

describe('version and updates', () => {
  it('/healthz answers without the access cookie and reveals only the version', async () => {
    const r = await app.inject({ url: '/healthz', headers: { host: HOST } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, commit: 'dev' });
    const foreign = await app.inject({ url: '/healthz', headers: { host: 'evil.example:5170' } });
    expect(foreign.statusCode).toBe(421);
  });

  it('a copy started by hand reports updates as not managed and refuses to apply', async () => {
    expect((await app.inject({ url: '/api/update', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/update', headers: auth })).json()).toMatchObject({ managed: false });
    const r = await app.inject({ method: 'POST', url: '/api/update/apply', headers: write, payload: {} });
    expect(r.statusCode).toBe(409);
  });

  it('shows a staged update and starts the install service only when one is ready', async () => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-app-'));
    fs.mkdirSync(path.join(appDir, 'state'));
    const started: string[] = [];
    const updates = new Updates(appDir, { commit: 'aaa1111', built_at: null }, async (u) => void started.push(u));
    const { db, c } = tempDb();
    const managed = await buildApp({ db, config: c, token: TOKEN, updates });

    expect((await managed.inject({ method: 'POST', url: '/api/update/apply', headers: write, payload: {} })).statusCode).toBe(409);
    fs.writeFileSync(path.join(appDir, 'state', 'staged.json'), JSON.stringify({ commit: 'bbb2222', from: 'aaa1111', changes: ['Dial counter'], at: 'x' }));
    const s = (await managed.inject({ url: '/api/update', headers: auth })).json();
    expect(s).toMatchObject({ managed: true, current: { commit: 'aaa1111' }, staged: { commit: 'bbb2222', changes: ['Dial counter'] } });

    // Cross-origin pages can't trigger a restart.
    expect((await managed.inject({ method: 'POST', url: '/api/update/apply', headers: { ...auth, origin: 'http://evil.example' }, payload: {} })).statusCode).toBe(403);
    expect((await managed.inject({ method: 'POST', url: '/api/update/apply', headers: write, payload: {} })).statusCode).toBe(202);
    expect((await managed.inject({ method: 'POST', url: '/api/update/check', headers: write, payload: {} })).statusCode).toBe(202);
    expect(started).toEqual(['mpcrm-apply.service', 'mpcrm-update.service']);
  });
});

describe('AI settings and PDF uploads over HTTP', () => {
  it('saves an API key but never sends it back, and keeps it out of the database', async () => {
    const { db, c } = tempDb();
    const a = await buildApp({ db, config: c, token: TOKEN });
    const put = await a.inject({ method: 'PUT', url: '/api/settings/ai/key', headers: write, payload: { name: 'anthropic_api_key', value: 'sk-ant-secret-xyz' } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('sk-ant-secret-xyz');
    expect(put.json().keys).toEqual({ anthropic_api_key: true, openai_api_key: false });
    const get = await a.inject({ url: '/api/settings/ai', headers: auth });
    expect(get.body).not.toContain('sk-ant-secret-xyz');
    const dump = JSON.stringify(db.prepare('SELECT * FROM app_setting').all());
    expect(dump).not.toContain('sk-ant-secret-xyz');
  });

  it('refuses a file that is not a PDF', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/drafts/pdf', headers: { ...write, 'content-type': 'application/pdf', 'x-file-name': 'x.pdf' }, payload: Buffer.from('hello'),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/not a PDF/);
  });
});
