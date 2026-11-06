import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, voidCall } from '../../src/server/domain/calls.js';
import { recordUnitrustEvents } from '../../src/server/domain/unitrustAppointments.js';
import { GoogleCalendar, type Fetch } from '../../src/server/domain/googleCalendar.js';
import { Secrets } from '../../src/server/ai/settings.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: 'http://127.0.0.1:5170' };
const CLIENT = '1234-abc.apps.googleusercontent.com';

let db: DB;
let secrets: Secrets;
let google: FakeGoogle;
let cal: GoogleCalendar;
let app: FastifyInstance;
const id = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const key = () => `k-${uuidv7()}`;
const day = (ahead: number) => {
  const d = new Date();
  d.setDate(d.getDate() + ahead);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface Ev { id: string; summary: string; description?: string; start: { date?: string; dateTime?: string }; end: unknown; status?: string; extendedProperties?: { private?: Record<string, string> } }

/** Just enough of Google's sign-in and Calendar API, and every request it got. */
class FakeGoogle {
  events: Ev[] = [];
  calls: string[] = [];
  refreshValid = true;
  private n = 0;
  fetch: Fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url);
    this.calls.push(`${method} ${u.pathname}`);
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.host === 'oauth2.googleapis.com') {
      const p = new URLSearchParams(init.body);
      if (p.get('client_id') !== CLIENT) return reply(401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'good' && p.get('code_verifier') ? reply(200, { access_token: 'a1', expires_in: 3600, refresh_token: 'r1' }) : reply(400, { error: 'invalid_grant' });
      return this.refreshValid && p.get('refresh_token') === 'r1' ? reply(200, { access_token: 'a2', expires_in: 3600 }) : reply(400, { error: 'invalid_grant' });
    }
    if (!init.headers?.authorization?.startsWith('Bearer a')) return reply(401, { error: { message: 'no token' } });
    const path = u.pathname.replace('/calendar/v3', '');
    if (path === '/users/me/calendarList/primary') return reply(200, { id: 'me@example.com' });
    if (path === '/users/me/calendarList') return reply(200, { items: [{ id: 'me@example.com', summary: 'Me', primary: true }, { id: 'work', summary: 'Work' }] });
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!m) return reply(404, { error: { message: 'no such path' } });
    if (method === 'GET') {
      const prop = u.searchParams.get('privateExtendedProperty');
      const q = u.searchParams.get('q');
      const from = u.searchParams.get('timeMin')!;
      const to = u.searchParams.get('timeMax')!;
      const at = (e: Ev) => (e.start.dateTime ? new Date(e.start.dateTime).toISOString() : new Date(`${e.start.date}T12:00:00`).toISOString());
      return reply(200, {
        items: this.events.filter((e) => at(e) >= from && at(e) < to
          && (!prop || `mpcrm_lead=${e.extendedProperties?.private?.mpcrm_lead}` === prop)
          && (!q || e.summary.toLowerCase().includes(q.toLowerCase()))),
      });
    }
    const body = JSON.parse(init.body ?? '{}') as Ev;
    if (method === 'POST') {
      const e = { ...body, id: `e${++this.n}` };
      this.events.push(e);
      return reply(200, e);
    }
    const e = this.events.find((x) => x.id === decodeURIComponent(m[2]!));
    if (!e) return reply(404, { error: { message: 'Not Found' } });
    Object.assign(e, body);
    return reply(200, e);
  };
}

/** Signs in through the CRM's own steps, with Google saying yes. */
async function connect() {
  cal.saveClient(CLIENT, 'secret-0123456789');
  const url = new URL(cal.authUrl());
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5170/api/google/callback');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  await cal.finishSignIn('good', url.searchParams.get('state')!, undefined);
}

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  db.prepare("UPDATE lead SET source_lead_id = 'L-77' WHERE first_name = 'Robert'").run();
  secrets = Secrets.inDataDir(t.c.dataDir);
  google = new FakeGoogle();
  cal = new GoogleCalendar(db, secrets, 'http://127.0.0.1:5170', google.fetch);
  app = await buildApp({ db, config: t.c, token: TOKEN, secrets, calendar: cal });
});

const setAppt = (first: string, when: string) => logManualCall(db, { lead_id: id(first), idempotency_key: key(), outcome_code: 'appointment', appointment_for: when });

describe('Google Calendar', () => {
  it('signs in with your own key, keeps the sign-in in the secrets file, and knows the account', async () => {
    expect(cal.status()).toMatchObject({ has_client: false, connected: false });
    expect(() => cal.authUrl()).toThrow('save your Google key');
    expect(() => cal.saveClient('nope', 'secret-0123456789')).toThrow('apps.googleusercontent.com');
    await connect();
    expect(cal.status()).toMatchObject({ has_client: true, connected: true, account: 'me@example.com' });
    expect(secrets.get('google_refresh_token')).toBe('r1');
    // A sign-in link is used once, and one the CRM didn't start does nothing.
    await expect(cal.finishSignIn('good', 'made-up', undefined)).rejects.toThrow('this sign-in link is old');
    const url = new URL(cal.authUrl());
    await expect(cal.finishSignIn(undefined, url.searchParams.get('state')!, 'access_denied')).rejects.toThrow('you said no to Google');
    cal.disconnect();
    expect(cal.status()).toMatchObject({ connected: false, account: null });
  });

  it('puts an appointment on the calendar once, and moves it when the appointment moves', async () => {
    await connect();
    setAppt('Robert', `${day(2)}T14:00`);
    expect(await cal.sync()).toMatchObject({ checked: 1, added: 1, moved: 0, found: 0, error: null });
    expect(google.events).toHaveLength(1);
    expect(google.events[0]).toMatchObject({ summary: '#MP L-77 Ray', start: { dateTime: `${day(2)}T14:00:00` }, end: { dateTime: `${day(2)}T15:00:00` } });
    expect(google.events[0]!.description).toContain(`http://127.0.0.1:5170/lead/${id('Robert')}`);
    // Nothing changed: nothing sent.
    google.calls = [];
    expect(await cal.sync()).toMatchObject({ checked: 1, added: 0, moved: 0 });
    expect(google.calls.filter((c) => !c.includes('oauth'))).toEqual([]);
    // Unitrust sends the appointment on another day: the same event moves.
    recordUnitrustEvents(db, [{ title: 'OH - CHASE - ROBERT RAY- (614) 555-0102 RAY', date: day(3), time: '09:30', color: 'blue' }], { today: day(0) });
    expect(await cal.sync()).toMatchObject({ moved: 1, added: 0 });
    expect(google.events).toHaveLength(1);
    expect(google.events[0]!.start).toEqual({ dateTime: `${day(3)}T09:30:00`, timeZone: expect.any(String) });
  });

  it("finds one you typed yourself, keeps it as you wrote it, and doesn't add another", async () => {
    await connect();
    const [y, m, d] = day(1).split('-').map(Number);
    google.events.push({ id: 'mine', summary: '#mp L-77 Ray (bring forms)', start: { dateTime: new Date(y!, m! - 1, d!, 11).toISOString() }, end: {} });
    setAppt('Robert', `${day(1)}T11:00`);
    expect(await cal.sync()).toMatchObject({ found: 1, added: 0 });
    expect(google.events).toHaveLength(1);
    // Moved: only its time changes; your title stays.
    setAppt('Robert', `${day(4)}T16:00`);
    expect(await cal.sync()).toMatchObject({ moved: 1 });
    expect(google.events[0]).toMatchObject({ id: 'mine', summary: '#mp L-77 Ray (bring forms)', start: { dateTime: `${day(4)}T16:00:00` } });
  });

  it('a day with no time is an all-day event; past and undone appointments are left alone', async () => {
    await connect();
    setAppt('Jane', day(5));
    setAppt('Ann', `${day(-1)}T10:00`);
    const undone = setAppt('Robert', `${day(2)}T10:00`);
    voidCall(db, undone.call_id);
    expect(await cal.sync()).toMatchObject({ checked: 1, added: 1 });
    expect(google.events[0]).toMatchObject({ summary: '#MP Doe', start: { date: day(5) }, end: { date: day(6) } });
  });

  it('an event deleted from the calendar is put back; a sign-in Google took back says so and signs out', async () => {
    await connect();
    setAppt('Robert', `${day(2)}T14:00`);
    await cal.sync();
    google.events = [];
    setAppt('Robert', `${day(2)}T15:00`);
    expect(await cal.sync()).toMatchObject({ added: 1, error: null });
    expect(google.events).toHaveLength(1);

    google.refreshValid = false;
    const c2 = new GoogleCalendar(db, secrets, 'http://127.0.0.1:5170', google.fetch);
    setAppt('Robert', `${day(3)}T15:00`);
    expect(await c2.sync()).toMatchObject({ error: 'Google sign-in expired or was taken back. Connect Google again in Settings.' });
    expect(c2.status()).toMatchObject({ connected: false, last_sync: { error: expect.stringContaining('Connect Google again') } });
    // Not connected or switched off: nothing is sent.
    expect(await c2.sync()).toBeNull();
  });

  it('routes: status, key, settings, calendars, sync now; the sign-in comes back without the cookie', async () => {
    expect((await app.inject({ url: '/api/google', headers: auth })).json()).toMatchObject({ has_client: false, settings: { enabled: true, calendar_id: 'primary', duration_min: 60 } });
    expect((await app.inject({ method: 'PUT', url: '/api/google/client', headers: write, payload: { client_id: CLIENT, client_secret: 'secret-0123456789' } })).json()).toMatchObject({ has_client: true });
    const { url } = (await app.inject({ method: 'POST', url: '/api/google/connect', headers: write })).json();
    const state = new URL(url).searchParams.get('state');
    // Google sends your browser back here; it has no CRM cookie.
    const back = await app.inject({ url: `/api/google/callback?code=good&state=${state}`, headers: { host: '127.0.0.1:5170' } });
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain('Google Calendar is connected');
    const again = await app.inject({ url: `/api/google/callback?code=good&state=${state}`, headers: { host: '127.0.0.1:5170' } });
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain('old or was not started from the CRM');
    // Nothing else opens without the cookie.
    expect((await app.inject({ url: '/api/google', headers: { host: '127.0.0.1:5170' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/google/calendars', headers: auth })).json().calendars).toEqual([
      { id: 'me@example.com', name: 'Me', primary: true }, { id: 'work', name: 'Work', primary: false },
    ]);
    expect((await app.inject({ method: 'PUT', url: '/api/google/settings', headers: write, payload: { enabled: true, calendar_id: 'work', duration_min: 45 } })).json().settings).toEqual({ enabled: true, calendar_id: 'work', duration_min: 45 });
    // Saving a call kicks a sync soon (not in tests: the timer only runs once the server starts it).
    expect((await app.inject({ method: 'POST', url: `/api/leads/${id('Robert')}/calls`, headers: write, payload: { idempotency_key: key(), outcome_code: 'appointment', appointment_for: `${day(1)}T08:00` } })).statusCode).toBe(200);
    const s = await app.inject({ method: 'POST', url: '/api/google/sync', headers: write });
    expect(s.json().result).toMatchObject({ added: 1 });
    expect(google.calls).toContain('POST /calendar/v3/calendars/work/events');
    expect(google.events[0]!.end).toMatchObject({ dateTime: `${day(1)}T08:45:00` });
    await app.inject({ method: 'PUT', url: '/api/google/settings', headers: write, payload: { enabled: false, calendar_id: 'work', duration_min: 45 } });
    expect((await app.inject({ method: 'POST', url: '/api/google/sync', headers: write })).json().error).toBe('connect Google and switch the calendar on first');
  });
});
