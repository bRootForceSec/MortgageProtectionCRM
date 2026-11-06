import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/connection.js';
import type { Secrets } from '../ai/settings.js';
import { getSetting, setSetting } from '../core/settings.js';
import { DomainError } from '../core/errors.js';
import { nowIso } from '../ids.js';
import { STANDING_APPOINTMENT } from './appointments.js';
import { calendarTag, leadLink } from '../../shared/leadLink.js';
import { DEFAULT_GOOGLE_CALENDAR, GoogleCalendarSettings, type CalendarSyncResult, type GoogleCalendarStatus } from '../../shared/googleCalendar.js';

// Google Calendar (shared/googleCalendar.ts). You make your own Google key (an OAuth client of the "Desktop app" kind)
// and paste it in Settings; signing in goes through your browser and back to this server, which keeps the refresh
// token in the secrets file. A sync puts each lead's upcoming appointment on the calendar as "#MP <Lead ID> <Last
// name>": if an event with that text is already on that day (you typed it), it's kept and remembered, not doubled.
// When the appointment moves, its event moves. Nothing is ever deleted from your calendar.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
const SETTINGS = 'google_calendar';
const LAST_SYNC = 'google_calendar_sync';
const ACCOUNT = 'google_calendar_account';
/** How far ahead appointments go on the calendar. */
const DAYS_AHEAD = 60;

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** A Google error, said for the user. `signedOut` when the sign-in no longer works. */
class GoogleError extends Error {
  constructor(message: string, readonly status: number, readonly signedOut = false) {
    super(message);
  }
}

/** YYYY-MM-DD on this computer. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A wall time ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM") moved by minutes, or days for a date. Same form back. */
function addToWall(wall: string, minutes: number): string {
  const [d, t] = wall.split('T');
  const [y, m, day] = d!.split('-').map(Number);
  const [h, mi] = (t ?? '00:00').split(':').map(Number);
  const x = new Date(Date.UTC(y!, m! - 1, day!, h!, mi!) + minutes * 60_000).toISOString();
  return t ? x.slice(0, 16) : x.slice(0, 10);
}

type Upcoming = { lead_id: string; scheduled_for: string; source_lead_id: string | null; last_name: string | null; phone_e164: string | null };

export function loadCalendarSettings(db: DB): GoogleCalendarSettings {
  const r = GoogleCalendarSettings.safeParse({ ...DEFAULT_GOOGLE_CALENDAR, ...getSetting<object>(db, SETTINGS) });
  return r.success ? r.data : DEFAULT_GOOGLE_CALENDAR;
}

/** Each lead's standing appointment from today on (DAYS_AHEAD days), leaving out ones run on the spot. */
export function upcomingAppointments(db: DB, today: string): Upcoming[] {
  return db
    .prepare(
      `SELECT a.lead_id, a.scheduled_for, l.source_lead_id, l.last_name, l.phone_e164
       FROM appointment a LEFT JOIN call c ON c.id = a.set_on_call_id JOIN lead l ON l.id = a.lead_id
       WHERE ${STANDING_APPOINTMENT} AND a.on_the_spot = 0
         AND a.created_at = (SELECT max(a2.created_at) FROM appointment a2 LEFT JOIN call c2 ON c2.id = a2.set_on_call_id
                              WHERE a2.lead_id = a.lead_id AND ${STANDING_APPOINTMENT.replace(/\ba\./g, 'a2.').replace(/\bc\./g, 'c2.')})
         AND substr(a.scheduled_for, 1, 10) BETWEEN @today AND date(@today, '+${DAYS_AHEAD} days')
       ORDER BY a.scheduled_for`,
    )
    .all({ today }) as Upcoming[];
}

/**
 * The Google side: signing in, and the sync. One per server. `origin` is this server (http://127.0.0.1:5170), where
 * Google sends you back after signing in.
 */
export class GoogleCalendar {
  private pending = new Map<string, { verifier: string; expires: number }>();
  private access: { token: string; expires: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private running: Promise<CalendarSyncResult | null> | null = null;

  constructor(
    private db: DB,
    private secrets: Secrets,
    private origin: string,
    private fetchFn: Fetch = (url, init) => fetch(url, init),
    private warn: (m: string) => void = () => {},
  ) {}

  get redirectUri() {
    return `${this.origin}/api/google/callback`;
  }

  status(): GoogleCalendarStatus {
    return {
      has_client: !!(this.secrets.get('google_client_id') && this.secrets.get('google_client_secret')),
      connected: !!this.secrets.get('google_refresh_token'),
      account: getSetting<string>(this.db, ACCOUNT),
      settings: loadCalendarSettings(this.db),
      last_sync: getSetting<CalendarSyncResult>(this.db, LAST_SYNC),
      redirect_uri: this.redirectUri,
    };
  }

  /** Saves your Google key. A new key signs you out, since the old sign-in belongs to the old key. */
  saveClient(clientId: string, clientSecret: string) {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new DomainError('that Client ID should end in .apps.googleusercontent.com');
    if (secret.length < 10) throw new DomainError('paste the Client secret too');
    if (id !== this.secrets.get('google_client_id')) this.disconnect();
    this.secrets.set('google_client_id', id);
    this.secrets.set('google_client_secret', secret);
  }

  saveSettings(input: unknown): GoogleCalendarSettings {
    const s = GoogleCalendarSettings.parse(input);
    const was = loadCalendarSettings(this.db);
    setSetting(this.db, SETTINGS, s);
    if (s.calendar_id !== was.calendar_id || (s.enabled && !was.enabled)) this.kick();
    return s;
  }

  /** The Google sign-in page to open. Google sends you back to /api/google/callback with `state`. */
  authUrl(): string {
    const clientId = this.secrets.get('google_client_id');
    if (!clientId) throw new DomainError('save your Google key (Client ID and secret) first');
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { verifier, expires: now + 15 * 60_000 });
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${q}`;
  }

  /** Finishes signing in, with what Google sent back. Throws a message for the page you land on. */
  async finishSignIn(code: string | undefined, state: string | undefined, error: string | undefined): Promise<void> {
    const p = state ? this.pending.get(state) : undefined;
    if (!state || !p || p.expires < Date.now()) throw new DomainError('this sign-in link is old or was not started from the CRM. Press Connect Google in Settings again.');
    this.pending.delete(state);
    if (error) throw new DomainError(error === 'access_denied' ? 'you said no to Google, so the CRM is not connected' : `Google said: ${error}`);
    if (!code) throw new DomainError('Google sent no sign-in code back');
    const body = await this.token({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: this.redirectUri });
    if (!body.refresh_token) throw new DomainError('Google sent no lasting sign-in. Press Connect Google again.');
    this.secrets.set('google_refresh_token', body.refresh_token);
    this.access = { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
    try {
      const primary = (await this.api('GET', '/users/me/calendarList/primary')) as { id?: string };
      if (primary.id) setSetting(this.db, ACCOUNT, primary.id);
    } catch (e) {
      this.warn(`google: couldn't read the account name: ${(e as Error).message}`);
    }
    this.kick();
  }

  disconnect() {
    this.secrets.set('google_refresh_token', null);
    this.access = null;
    setSetting(this.db, ACCOUNT, null);
  }

  /** Your calendars you can add events to. */
  async calendars(): Promise<{ id: string; name: string; primary: boolean }[]> {
    const r = (await this.api('GET', '/users/me/calendarList?minAccessRole=writer')) as { items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[] };
    return (r.items ?? []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary }));
  }

  private async token(params: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const clientId = this.secrets.get('google_client_id');
    const clientSecret = this.secrets.get('google_client_secret');
    if (!clientId || !clientSecret) throw new GoogleError('save your Google key first', 400, true);
    const r = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }).toString(),
    });
    const body = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
    if (!r.ok || !body.access_token) {
      if (body.error === 'invalid_grant') throw new GoogleError('Google sign-in expired or was taken back. Connect Google again in Settings.', r.status, true);
      if (body.error === 'invalid_client') throw new GoogleError('Google did not accept your key (Client ID or secret). Paste it again.', r.status, true);
      throw new GoogleError(`Google sign-in failed: ${body.error_description || body.error || r.status}`, r.status);
    }
    return { access_token: body.access_token, expires_in: body.expires_in ?? 3600, refresh_token: body.refresh_token };
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expires > Date.now()) return this.access.token;
    const refresh = this.secrets.get('google_refresh_token');
    if (!refresh) throw new GoogleError('not connected to Google', 401, true);
    try {
      const t = await this.token({ grant_type: 'refresh_token', refresh_token: refresh });
      this.access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
      return t.access_token;
    } catch (e) {
      if (e instanceof GoogleError && e.signedOut) this.disconnect();
      throw e;
    }
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const r = await this.fetchFn(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (r.ok) return r.status === 204 ? {} : r.json();
    const err = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    if (r.status === 401) this.access = null;
    throw new GoogleError(`Google Calendar said: ${err.error?.message ?? r.status}`, r.status);
  }

  /** The event for an appointment: timed in this computer's time zone, or all day when there's no time. */
  private eventBody(a: Upcoming, s: GoogleCalendarSettings) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timed = a.scheduled_for.includes('T');
    const when = timed
      ? { start: { dateTime: `${a.scheduled_for}:00`, timeZone: tz }, end: { dateTime: `${addToWall(a.scheduled_for, s.duration_min)}:00`, timeZone: tz } }
      : { start: { date: a.scheduled_for }, end: { date: addToWall(a.scheduled_for, 24 * 60) } };
    return {
      summary: calendarTag(a),
      description: [a.phone_e164 ? `Phone: ${a.phone_e164}` : null, `Open in the CRM: ${leadLink(this.origin, a.lead_id)}`].filter(Boolean).join('\n'),
      ...when,
      extendedProperties: { private: { mpcrm_lead: a.lead_id } },
    };
  }

  /** An event already on that day for this lead: one the CRM made, or one you typed with its "#MP <Lead ID>". */
  private async findExisting(calendar: string, a: Upcoming): Promise<{ id: string; summary: string } | null> {
    // That day on this computer, as times Google understands.
    const [y, m, d] = a.scheduled_for.slice(0, 10).split('-').map(Number);
    const from = new Date(y!, m! - 1, d!).toISOString();
    const to = new Date(y!, m! - 1, d! + 1).toISOString();
    const base = `/calendars/${encodeURIComponent(calendar)}/events?singleEvents=true&maxResults=50&timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}`;
    type Items = { items?: { id: string; summary?: string; status?: string }[] };
    const onDay = (r: Items) => (r.items ?? []).filter((e) => e.status !== 'cancelled');
    const ours = onDay((await this.api('GET', `${base}&privateExtendedProperty=${encodeURIComponent(`mpcrm_lead=${a.lead_id}`)}`)) as Items);
    if (ours[0]) return { id: ours[0].id, summary: ours[0].summary ?? '' };
    // By its text only when the lead has a Lead ID: "#MP Smith" alone could be someone else.
    if (!a.source_lead_id) return null;
    const tag = `#MP ${a.source_lead_id}`.toLowerCase();
    const typed = onDay((await this.api('GET', `${base}&q=${encodeURIComponent(`#MP ${a.source_lead_id}`)}`)) as Items)
      .find((e) => (e.summary ?? '').toLowerCase().includes(tag));
    return typed ? { id: typed.id, summary: typed.summary ?? '' } : null;
  }

  /**
   * Puts upcoming appointments on the calendar: adds the missing ones and moves the ones whose time changed. Keeps
   * what it did for Settings. Only one runs at a time; returns null when not set up.
   */
  async sync(now = new Date()): Promise<CalendarSyncResult | null> {
    if (this.running) return this.running;
    const s = loadCalendarSettings(this.db);
    if (!s.enabled || !this.secrets.get('google_refresh_token')) return null;
    this.running = this.doSync(s, now).finally(() => (this.running = null));
    return this.running;
  }

  private async doSync(s: GoogleCalendarSettings, now: Date): Promise<CalendarSyncResult> {
    const res: CalendarSyncResult = { at: nowIso(), checked: 0, added: 0, moved: 0, found: 0, error: null };
    const today = localDay(now);
    const cal = encodeURIComponent(s.calendar_id);
    const mapped = this.db.prepare('SELECT google_event_id, starts, summary, origin FROM calendar_event WHERE lead_id = ? AND calendar_id = ?');
    const keep = this.db.prepare(
      `INSERT INTO calendar_event (lead_id, calendar_id, google_event_id, starts, summary, origin, synced_at) VALUES (@lead_id, @calendar_id, @id, @starts, @summary, @origin, @at)
       ON CONFLICT (lead_id, calendar_id) DO UPDATE SET google_event_id = excluded.google_event_id, starts = excluded.starts, summary = excluded.summary, origin = excluded.origin, synced_at = excluded.synced_at`,
    );
    try {
      for (const a of upcomingAppointments(this.db, today)) {
        res.checked++;
        const body = this.eventBody(a, s);
        const row = mapped.get(a.lead_id, s.calendar_id) as { google_event_id: string; starts: string; summary: string; origin: 'added' | 'found' } | undefined;
        const save = (id: string, origin: 'added' | 'found', summary: string) =>
          keep.run({ lead_id: a.lead_id, calendar_id: s.calendar_id, id, starts: a.scheduled_for, summary, origin, at: res.at });
        // The event for this appointment is on the calendar already (or was, for an earlier day still to come): move it if needed.
        if (row && row.starts.slice(0, 10) >= today) {
          if (row.starts === a.scheduled_for) continue;
          try {
            // An event you typed keeps your title and notes; only its time moves.
            const patch = row.origin === 'added' ? body : { start: body.start, end: body.end };
            await this.api('PATCH', `/calendars/${cal}/events/${encodeURIComponent(row.google_event_id)}`, patch);
            save(row.google_event_id, row.origin, row.origin === 'added' ? body.summary : row.summary);
            res.moved++;
            continue;
          } catch (e) {
            // Deleted from the calendar: put it back below.
            if (!(e instanceof GoogleError && (e.status === 404 || e.status === 410))) throw e;
          }
        }
        const there = await this.findExisting(s.calendar_id, a);
        if (there) {
          save(there.id, 'found', there.summary);
          res.found++;
          continue;
        }
        const made = (await this.api('POST', `/calendars/${cal}/events`, body)) as { id: string };
        save(made.id, 'added', body.summary);
        res.added++;
      }
    } catch (e) {
      res.error = (e as Error).message;
    }
    setSetting(this.db, LAST_SYNC, res);
    return res;
  }

  /** Syncs a few seconds from now (after a call or a Unitrust read), once, however many times it's asked. */
  kick(delayMs = 5_000) {
    if (this.soon || !this.timer) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.tick();
    }, delayMs);
    this.soon.unref();
  }

  private async tick() {
    try {
      const r = await this.sync();
      if (r?.error) this.warn(`google calendar sync: ${r.error}`);
    } catch (e) {
      this.warn(`google calendar sync failed: ${(e as Error).message}`);
    }
  }

  /** Syncs every 15 minutes while the app runs (and soon after it opens). */
  start(firstAfterMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), 15 * 60_000);
    this.timer.unref();
    this.kick(firstAfterMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = this.soon = null;
  }
}
