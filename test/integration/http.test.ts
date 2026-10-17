import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/http/app.js';
import { Writable } from 'node:stream';
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
    const parse = await app.inject({
      method: 'POST', url: '/api/imports/parse', headers: { ...write, 'content-type': 'application/octet-stream', 'x-file-name': 'leads.xlsx' },
      payload: await sampleXlsx(),
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
      payload: await sampleXlsx(),
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
