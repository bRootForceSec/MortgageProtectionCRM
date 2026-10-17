import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/http/app.js';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import type { DB } from '../../src/server/db/connection.js';
import { Secrets } from '../../src/server/ai/settings.js';
import { GoogleCalendar } from '../../src/server/calendar/google.js';
import {
  CalendarWorker, MAX_REAPPLY, NOTE_START, eventTitle, ourEventId, readUnitrust, stripNote, withNote, lastNameOf,
} from '../../src/server/calendar/sync.js';
import { uuidv7 } from '../../src/server/ids.js';
import { FakeGoogle, FAKE_ENDPOINTS } from '../fakeGoogle.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const HOST = '127.0.0.1:5170';
const auth = { host: HOST, cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: 'http://127.0.0.1:5170' };

const UNITRUST_TEXT = [
  'App_Management: https://myunitrust.com/app_mng/1792075936516x748922075734196600',
  'LEAD ID: 503534129',
  'BORROWER: JOSEPH COX',
].join('\n');

describe('note block', () => {
  it('puts the note on top and leaves Unitrust text as it was', () => {
    const out = withNote(UNITRUST_TEXT, 'Wife handles the bills');
    expect(out.startsWith(`${NOTE_START} Wife handles the bills\n`)).toBe(true);
    expect(out.endsWith(UNITRUST_TEXT)).toBe(true);
    expect(stripNote(out)).toBe(UNITRUST_TEXT);
  });

  it('is the same after applying twice, and replaces an older note', () => {
    const once = withNote(UNITRUST_TEXT, 'one');
    expect(withNote(once, 'one')).toBe(once);
    const changed = withNote(once, 'two');
    expect(changed).toBe(withNote(UNITRUST_TEXT, 'two'));
    expect(changed).not.toMatch(/one/);
    expect(withNote(once, '')).toBe(UNITRUST_TEXT);
  });

  it('writes HTML when the description is HTML, and escapes the note', () => {
    const html = UNITRUST_TEXT.replace(/\n/g, '<br>');
    const out = withNote(html, 'Call <cell> first\nthen home');
    expect(out.startsWith(`${NOTE_START} Call &lt;cell&gt; first<br>then home<br>`)).toBe(true);
    expect(out.endsWith(html)).toBe(true);
    expect(stripNote(out)).toBe(html);
  });

  it('reads the LEAD ID and App_Management link, plain or HTML, ignoring our note', () => {
    expect(readUnitrust(UNITRUST_TEXT)).toEqual({ leadId: '503534129', url: 'https://myunitrust.com/app_mng/1792075936516x748922075734196600' });
    const html = '<a href="https://myunitrust.com/app_mng/abc">App_Management: https://myunitrust.com/app_mng/abc</a><br>LEAD ID: 77<br>';
    expect(readUnitrust(html).leadId).toBe('77');
    expect(readUnitrust(withNote(UNITRUST_TEXT, 'LEAD ID: 999')).leadId).toBe('503534129');
    expect(readUnitrust('just a dentist appointment').leadId).toBeNull();
  });

  it('title and event id follow the rules', () => {
    expect(eventTitle('503534129', 'Cox')).toBe('#MP 503534129 COX');
    expect(lastNameOf({ last_name: null, full_name_raw: 'JOSEPH  COX ' })).toBe('COX');
    // Google event ids: lowercase a–v and 0–9, 5 to 1024 long.
    expect(ourEventId(uuidv7())).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});

describe('Google Calendar over HTTP', () => {
  let db: DB;
  let app: FastifyInstance;
  let fake: FakeGoogle;
  let google: GoogleCalendar;
  let worker: CalendarWorker;
  let jane: string;
  let robert: string;
  const tomorrow3pm = () => {
    const d = new Date(Date.now() + 86400_000);
    d.setUTCHours(19, 0, 0, 0);
    return d.toISOString();
  };

  beforeEach(async () => {
    const t = tempDb();
    db = t.db;
    const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
    const sheet = parsed.sheets[0]!;
    commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
    jane = (db.prepare("SELECT id FROM lead WHERE first_name = 'Jane'").get() as any).id;
    robert = (db.prepare("SELECT id FROM lead WHERE first_name = 'Robert'").get() as any).id;
    db.prepare("UPDATE lead SET source_lead_id = '503534129' WHERE id = ?").run(jane);
    fake = new FakeGoogle();
    const secrets = Secrets.inDataDir(t.c.dataDir);
    google = new GoogleCalendar(db, secrets, { fetch: fake.fetch, endpoints: FAKE_ENDPOINTS });
    worker = new CalendarWorker(db, google);
    app = await buildApp({ db, config: t.c, token: TOKEN, google, calendar: worker });
  });

  async function connect() {
    let r = await app.inject({ method: 'PUT', url: '/api/calendar/client', headers: write, payload: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'secret-1' } });
    expect(r.statusCode).toBe(200);
    r = await app.inject({ method: 'POST', url: '/api/calendar/connect', headers: write, payload: {} });
    const url = new URL(r.json().url);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5170/oauth/google/callback');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;
    r = await app.inject({ url: `/oauth/google/callback?state=${state}&code=good-code`, headers: { host: HOST } });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/#settings');
    const s = (await app.inject({ url: '/api/calendar', headers: auth })).json();
    expect(s).toMatchObject({ connected: true, email: 'agent@gmail.com' });
  }

  const book = (leadId: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST', url: `/api/leads/${leadId}/calls`, headers: write,
      payload: { idempotency_key: `k-${uuidv7()}`, outcome_code: 'appointment', appointment_at: tomorrow3pm(), note: 'Wife handles the bills', ...extra },
    });

  const syncRow = (leadId: string) => db.prepare('SELECT * FROM calendar_sync WHERE lead_id = ? ORDER BY created_at DESC').get(leadId) as any;

  it('refuses a sign-in callback it did not start', async () => {
    const r = await app.inject({ url: '/oauth/google/callback?state=made-up&code=good-code', headers: { host: HOST } });
    expect(r.statusCode).toBe(400);
  });

  it('books nothing on the calendar while not connected', async () => {
    const r = await book(jane);
    expect(r.statusCode).toBe(200);
    expect(r.json().calendar).toBeNull();
    expect(syncRow(jane)).toBeUndefined();
  });

  it('creates the #MP event, then puts the note on top of Unitrust’s event without touching the rest', async () => {
    await connect();
    const r = await book(jane);
    expect(r.json().calendar).toBe('queued');
    await worker.tick();

    const row = syncRow(jane);
    expect(row.state).toBe('waiting');
    const ours = fake.events.get(row.our_event_id)!;
    expect(ours.summary).toBe('#MP 503534129 DOE');
    expect(ours.description).toBe('Wife handles the bills');
    expect(Date.parse(ours.end!.dateTime!) - Date.parse(ours.start!.dateTime!)).toBe(30 * 60_000);
    expect(ours.start!.dateTime).toBe(tomorrow3pm());
    expect(fake.calls.find((c) => c.method === 'POST')!.query.sendUpdates).toBe('none');

    const ut = fake.unitrustReplaces(row.our_event_id, { leadId: '503534129', borrower: 'JANE DOE' });
    const before = ut.description!;
    await worker.tick();
    const after = fake.events.get(ut.id)!.description!;
    expect(after).toBe(`${NOTE_START} Wife handles the bills\n────────\n\n${before}`);
    const patch = fake.calls.filter((c) => c.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(Object.keys(patch[0]!.body)).toEqual(['description']);
    expect(patch[0]!.query.sendUpdates).toBe('none');
    expect(syncRow(jane)).toMatchObject({ state: 'noted', unitrust_event_id: ut.id, unitrust_url: 'https://myunitrust.com/app_mng/1792075936516x748922075734196600' });

    // Nothing changes on later rounds.
    await worker.tick();
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);

    // Lead screen shows it.
    const d = (await app.inject({ url: `/api/leads/${jane}`, headers: auth })).json();
    expect(d.appointments[0]).toMatchObject({ calendar_state: 'noted', calendar_note: 'Wife handles the bills' });
  });

  it('works when Unitrust writes HTML', async () => {
    await connect();
    await book(jane);
    await worker.tick();
    const ut = fake.unitrustReplaces(syncRow(jane).our_event_id, { leadId: '503534129', borrower: 'JANE DOE', html: true });
    await worker.tick();
    expect(fake.events.get(ut.id)!.description!.startsWith(`${NOTE_START} Wife handles the bills<br>────────<br><br>App_Management:`)).toBe(true);
  });

  it('leaves events for other leads and ordinary events alone', async () => {
    await connect();
    await book(jane);
    await worker.tick();
    const row = syncRow(jane);
    fake.events.set('dentist', { id: 'dentist', summary: 'Dentist', description: 'bring card', start: { dateTime: tomorrow3pm() }, end: { dateTime: tomorrow3pm() }, updated: new Date().toISOString() } as any);
    fake.unitrustReplaces(row.our_event_id, { leadId: '111111111', borrower: 'SOMEONE ELSE', id: 'other' });
    await worker.tick();
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(syncRow(jane).state).toBe('waiting');
  });

  it('asks for the lead ID when the lead has none, and saves it on the lead', async () => {
    await connect();
    const missing = await book(robert);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/lead ID/);
    expect(db.prepare('SELECT count(*) n FROM call WHERE lead_id = ?').get(robert)).toEqual({ n: 0 });

    const ok = await book(robert, { calendar: { add: true, source_lead_id: '506346756' } });
    expect(ok.statusCode).toBe(200);
    expect(db.prepare('SELECT source_lead_id FROM lead WHERE id = ?').get(robert)).toEqual({ source_lead_id: '506346756' });
    expect(db.prepare("SELECT new_value FROM lead_change WHERE lead_id = ? AND field = 'source_lead_id'").get(robert)).toEqual({ new_value: '506346756' });
    expect(syncRow(robert).title).toBe('#MP 506346756 RAY');

    // Unticked: no calendar, no lead ID needed.
    const skip = await book(robert, { calendar: { add: false } });
    expect(skip.json().calendar).toBeNull();
  });

  it('keeps the event queued while offline and sends it once (no duplicate after a lost answer)', async () => {
    await connect();
    await book(jane);
    fake.offline = true;
    await worker.tick();
    expect(syncRow(jane)).toMatchObject({ state: 'queued', attempts: 1 });
    const problems = (await app.inject({ url: '/api/calendar', headers: auth })).json().problems;
    expect(problems[0].kind).toBe('not_sent');

    fake.offline = false;
    db.prepare('UPDATE calendar_sync SET next_attempt_at = NULL').run();
    // Google made the event but the answer got lost: the retry gets 409 and that counts as done.
    const row = syncRow(jane);
    fake.events.set(row.our_event_id, { id: row.our_event_id, summary: row.title, start: { dateTime: tomorrow3pm() }, end: { dateTime: tomorrow3pm() }, updated: new Date().toISOString() } as any);
    await worker.tick();
    expect(syncRow(jane).state).toBe('waiting');
    expect([...fake.events.keys()].filter((k) => k.startsWith('mpcrm'))).toHaveLength(1);
  });

  it('puts the note back if Unitrust rewrites its event, but stops after a few tries', async () => {
    await connect();
    await book(jane);
    await worker.tick();
    const ut = fake.unitrustReplaces(syncRow(jane).our_event_id, { leadId: '503534129', borrower: 'JANE DOE' });
    await worker.tick();
    for (let i = 0; i < MAX_REAPPLY; i++) {
      fake.rewrite(ut.id, UNITRUST_TEXT);
      await worker.tick();
      expect(fake.events.get(ut.id)!.description!.startsWith(NOTE_START)).toBe(true);
    }
    fake.rewrite(ut.id, UNITRUST_TEXT);
    await worker.tick();
    expect(fake.events.get(ut.id)!.description).toBe(UNITRUST_TEXT);
    expect(syncRow(jane)).toMatchObject({ state: 'failed', reapply_count: MAX_REAPPLY });
  });

  it('says so when Google won’t let the app change Unitrust’s event', async () => {
    await connect();
    await book(jane);
    await worker.tick();
    fake.ignoreDescriptionEdits = true;
    fake.unitrustReplaces(syncRow(jane).our_event_id, { leadId: '503534129', borrower: 'JANE DOE' });
    await worker.tick();
    expect(syncRow(jane).state).toBe('failed');
    expect(syncRow(jane).last_error).toMatch(/wouldn't let the app change/);
  });

  it('changing the note later updates Unitrust’s event', async () => {
    await connect();
    await book(jane);
    await worker.tick();
    const ut = fake.unitrustReplaces(syncRow(jane).our_event_id, { leadId: '503534129', borrower: 'JANE DOE' });
    await worker.tick();
    const apptId = syncRow(jane).appointment_id;
    const r = await app.inject({ method: 'PUT', url: `/api/calendar/appointments/${apptId}/note`, headers: write, payload: { note: 'Call her cell' } });
    expect(r.statusCode).toBe(200);
    await worker.tick();
    expect(fake.events.get(ut.id)!.description!.startsWith(`${NOTE_START} Call her cell\n`)).toBe(true);
    expect(fake.events.get(ut.id)!.description).not.toMatch(/Wife/);
  });

  it('undo before Unitrust sees it deletes the #MP event; after, it warns to cancel in Unitrust', async () => {
    await connect();
    const first = (await book(jane)).json();
    await worker.tick();
    const ourId = syncRow(jane).our_event_id;
    let v = await app.inject({ method: 'POST', url: `/api/calls/${first.call_id}/void`, headers: write, payload: {} });
    expect(v.json().calendar_unitrust_has_it).toBe(false);
    await worker.tick();
    expect(fake.events.has(ourId)).toBe(false);
    expect(syncRow(jane).state).toBe('canceled');

    const second = (await book(jane)).json();
    await worker.tick();
    fake.unitrustReplaces(syncRow(jane).our_event_id, { leadId: '503534129', borrower: 'JANE DOE' });
    await worker.tick();
    v = await app.inject({ method: 'POST', url: `/api/calls/${second.call_id}/void`, headers: write, payload: {} });
    expect(v.json().calendar_unitrust_has_it).toBe(true);
    await worker.tick();
    const problems = (await app.inject({ url: '/api/calendar', headers: auth })).json().problems;
    expect(problems.map((p: any) => p.kind)).toContain('unitrust_after_undo');
  });

  it('a reschedule gets a new #MP event with the same note', async () => {
    await connect();
    await book(jane);
    await worker.tick();
    const old = syncRow(jane);
    const newTime = new Date(Date.parse(tomorrow3pm()) + 86400_000).toISOString();
    const r = await app.inject({ method: 'POST', url: `/api/appointments/${old.appointment_id}/result`, headers: write, payload: { result: 'rescheduled', rescheduled_for: newTime } });
    expect(r.statusCode).toBe(200);
    await worker.tick();
    const fresh = db.prepare('SELECT * FROM calendar_sync WHERE appointment_id = ?').get(r.json().new_appointment_id) as any;
    expect(fresh).toMatchObject({ state: 'waiting', note: 'Wife handles the bills', title: '#MP 503534129 DOE', starts_at: newTime });
  });

  it('flags a different time on Unitrust’s event and can take it', async () => {
    await connect();
    await book(jane);
    await worker.tick();
    fake.unitrustReplaces(syncRow(jane).our_event_id, { leadId: '503534129', borrower: 'JANE DOE', startShiftMin: 30 });
    await worker.tick();
    let s = (await app.inject({ url: '/api/calendar', headers: auth })).json();
    const p = s.problems.find((x: any) => x.kind === 'time_differs');
    expect(p).toBeTruthy();
    const r = await app.inject({ method: 'POST', url: `/api/calendar/appointments/${p.appointment_id}/use-unitrust-time`, headers: write, payload: {} });
    expect(r.statusCode).toBe(200);
    expect((db.prepare('SELECT scheduled_for FROM appointment WHERE id = ?').get(p.appointment_id) as any).scheduled_for).toBe(p.unitrust_start);
    s = (await app.inject({ url: '/api/calendar', headers: auth })).json();
    expect(s.problems.find((x: any) => x.kind === 'time_differs')).toBeUndefined();
  });

  it('asks you to connect again when Google drops the sign-in', async () => {
    await connect();
    fake.validRefresh = 'something-else';
    (google as any).access = null;
    await book(jane);
    await worker.tick();
    const s = (await app.inject({ url: '/api/calendar', headers: auth })).json();
    expect(s).toMatchObject({ connected: false, needs_reconnect: true });
    expect(syncRow(jane).state).toBe('queued');
  });

  it('never sends the secret or sign-in to the browser', async () => {
    await connect();
    const body = (await app.inject({ url: '/api/calendar', headers: auth })).body;
    expect(body).not.toMatch(/secret-1|refresh-1|access-/);
    const meta = (await app.inject({ url: '/api/meta', headers: auth })).body;
    expect(meta).not.toMatch(/secret-1|refresh-1/);
  });
});
