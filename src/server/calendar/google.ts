import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/connection.js';
import { getSetting, setSetting, type Secrets } from '../ai/settings.js';

// Google sign-in and the few Calendar calls the app makes, with plain fetch (no Google library).
// Sign-in is the "desktop app" kind: Google sends the browser back to this app on 127.0.0.1, so nothing is exposed
// to the internet. The client secret and the long-lived sign-in (refresh token) live in secrets.json (mode 600);
// the access token is kept in memory only.

export interface GoogleEndpoints {
  auth: string;
  token: string;
  api: string;
  revoke: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  api: 'https://www.googleapis.com/calendar/v3',
  revoke: 'https://oauth2.googleapis.com/revoke',
};

/** Calendar events only (not Gmail, Drive or contacts), plus your email address to show who is connected. */
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];

/** The main calendar, which Unitrust watches. */
export const CALENDAR_ID = 'primary';

export interface GoogleSettings {
  client_id: string | null;
  email: string | null;
  connected_at: string | null;
  /** Set when Google stops accepting the saved sign-in (password change, access removed, ...). */
  needs_reconnect: boolean;
  reconnect_reason: string | null;
}

const SETTING_KEY = 'google_calendar';

/** Sign-in no longer works; you have to connect again from Settings. */
export class GoogleAuthError extends Error {}

/** Google answered with an error. `status` 0 means it couldn't be reached at all. */
export class GoogleApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
  /** Worth trying again later (network trouble, rate limits, Google having a bad minute). */
  get temporary() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
  updated?: string;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  attendees?: { email?: string }[];
}

interface PendingAuth {
  verifier: string;
  redirectUri: string;
  at: number;
}

export class GoogleCalendar {
  private access: { token: string; expires: number } | null = null;
  private pending = new Map<string, PendingAuth>();
  private fetch: typeof fetch;
  readonly endpoints: GoogleEndpoints;
  /** The last sign-in problem, shown in Settings after Google sends you back. */
  lastConnectError: string | null = null;

  constructor(
    private db: DB,
    private secrets: Secrets,
    opts: { fetch?: typeof fetch; endpoints?: GoogleEndpoints; now?: () => number } = {},
  ) {
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.endpoints = opts.endpoints ?? GOOGLE_ENDPOINTS;
    this.now = opts.now ?? Date.now;
  }
  private now: () => number;

  settings(): GoogleSettings {
    const s = getSetting<Partial<GoogleSettings>>(this.db, SETTING_KEY) ?? {};
    return {
      client_id: s.client_id ?? null,
      email: s.email ?? null,
      connected_at: s.connected_at ?? null,
      needs_reconnect: !!s.needs_reconnect,
      reconnect_reason: s.reconnect_reason ?? null,
    };
  }

  private saveSettings(patch: Partial<GoogleSettings>) {
    setSetting(this.db, SETTING_KEY, { ...this.settings(), ...patch });
  }

  /** Client ID and secret are saved. */
  configured() {
    return !!this.settings().client_id && !!this.secrets.get('google_client_secret');
  }

  /** Signed in and Google still accepts it. */
  connected() {
    return this.configured() && !!this.secrets.get('google_refresh_token') && !this.settings().needs_reconnect;
  }

  saveClient(clientId: string, clientSecret: string | null) {
    const id = clientId.trim();
    const before = this.settings().client_id;
    this.saveSettings({ client_id: id || null });
    if (clientSecret !== null) this.secrets.set('google_client_secret', clientSecret.trim() || null);
    // A different client can't use the old sign-in.
    if (before && before !== id) this.forget();
  }

  /** Builds the Google sign-in link. Google sends the browser back to redirectUri with a one-time code. */
  startAuth(redirectUri: string): string {
    const s = this.settings();
    if (!this.configured()) throw new Error('Save the client ID and secret first.');
    for (const [k, p] of this.pending) if (this.now() - p.at > 15 * 60_000) this.pending.delete(k);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { verifier, redirectUri, at: this.now() });
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({
      client_id: s.client_id!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      // Always ask, so Google hands out a long-lived sign-in even if you connected before.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${this.endpoints.auth}?${q}`;
  }

  /** Whether `state` belongs to a sign-in this app started (and hasn't used yet). */
  knowsState(state: string) {
    return this.pending.has(state);
  }

  dropState(state: string) {
    this.pending.delete(state);
  }

  /** Finishes sign-in with the code Google sent back. */
  async finishAuth(state: string, code: string) {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || this.now() - p.at > 15 * 60_000) throw new Error('This sign-in link expired. Click Connect again.');
    const j = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    });
    if (!j.refresh_token) throw new Error('Google did not grant offline access. Remove the app at myaccount.google.com/permissions and connect again.');
    const scopes = String(j.scope ?? '').split(' ');
    if (!scopes.includes('https://www.googleapis.com/auth/calendar.events')) {
      throw new Error('Calendar access was not granted. Tick the calendar box on the Google screen and try again.');
    }
    this.secrets.set('google_refresh_token', j.refresh_token);
    this.access = j.access_token ? { token: j.access_token, expires: this.now() + (Number(j.expires_in) || 3600) * 1000 } : null;
    this.saveSettings({
      email: emailFromIdToken(j.id_token),
      connected_at: new Date(this.now()).toISOString(),
      needs_reconnect: false,
      reconnect_reason: null,
    });
    this.lastConnectError = null;
  }

  /** Signs out: tells Google to drop the sign-in (best effort) and forgets it here. */
  async disconnect() {
    const rt = this.secrets.get('google_refresh_token');
    if (rt) {
      try {
        await this.fetch(this.endpoints.revoke, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: rt }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        /* forgetting it here is what matters */
      }
    }
    this.forget();
  }

  private forget() {
    this.secrets.set('google_refresh_token', null);
    this.access = null;
    this.saveSettings({ email: null, connected_at: null, needs_reconnect: false, reconnect_reason: null });
  }

  private async tokenRequest(params: Record<string, string>): Promise<any> {
    const s = this.settings();
    let r: Response;
    try {
      r = await this.fetch(this.endpoints.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: s.client_id ?? '', client_secret: this.secrets.get('google_client_secret') ?? '', ...params }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e: any) {
      throw new GoogleApiError(`Couldn't reach Google (${e.message})`, 0);
    }
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j.error_description || j.error || `HTTP ${r.status}`;
      // invalid_grant: the saved sign-in was revoked or expired. invalid_client: wrong ID or secret.
      if (j.error === 'invalid_grant' || j.error === 'invalid_client' || j.error === 'unauthorized_client') throw new GoogleAuthError(msg);
      throw new GoogleApiError(`Google sign-in failed: ${msg}`, r.status);
    }
    return j;
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expires - 60_000 > this.now()) return this.access.token;
    const rt = this.secrets.get('google_refresh_token');
    if (!rt || !this.configured()) throw new GoogleAuthError('Not connected to Google Calendar.');
    try {
      const j = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: rt });
      this.access = { token: j.access_token, expires: this.now() + (Number(j.expires_in) || 3600) * 1000 };
      return this.access.token;
    } catch (e) {
      if (e instanceof GoogleAuthError) this.markNeedsReconnect(e.message);
      throw e;
    }
  }

  private markNeedsReconnect(reason: string) {
    this.access = null;
    this.saveSettings({ needs_reconnect: true, reconnect_reason: reason });
  }

  /** One Calendar API call. Retries once with a fresh access token if Google says the old one expired. */
  async call<T = any>(method: string, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const q = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
      let r: Response;
      try {
        r = await this.fetch(`${this.endpoints.api}${path}${q}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e: any) {
        throw new GoogleApiError(`Couldn't reach Google (${e.message})`, 0);
      }
      if (r.status === 401 && attempt === 0) {
        this.access = null;
        continue;
      }
      if (r.status === 204) return undefined as T;
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error?.message || `HTTP ${r.status}`;
        if (r.status === 401) {
          this.markNeedsReconnect(msg);
          throw new GoogleAuthError(msg);
        }
        throw new GoogleApiError(msg, r.status);
      }
      return j as T;
    }
  }

  private cal(path = '') {
    return `/calendars/${encodeURIComponent(CALENDAR_ID)}/events${path}`;
  }

  insertEvent(ev: Omit<CalendarEvent, 'id'> & { id: string }) {
    return this.call<CalendarEvent>('POST', this.cal(), { query: { sendUpdates: 'none' }, body: ev });
  }

  getEvent(id: string) {
    return this.call<CalendarEvent>('GET', this.cal(`/${encodeURIComponent(id)}`));
  }

  /** Changes only the fields given. Never emails the guests. */
  patchEvent(id: string, patch: Partial<CalendarEvent>) {
    return this.call<CalendarEvent>('PATCH', this.cal(`/${encodeURIComponent(id)}`), { query: { sendUpdates: 'none' }, body: patch });
  }

  deleteEvent(id: string) {
    return this.call<void>('DELETE', this.cal(`/${encodeURIComponent(id)}`), { query: { sendUpdates: 'none' } });
  }

  /** Events between two times, optionally only ones changed since `updatedMin`. Follows every page. */
  async listEvents(q: { timeMin: string; timeMax: string; updatedMin?: string | null }): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const query: Record<string, string> = { timeMin: q.timeMin, timeMax: q.timeMax, singleEvents: 'true', maxResults: '250' };
      if (q.updatedMin) query.updatedMin = q.updatedMin;
      if (pageToken) query.pageToken = pageToken;
      const j = await this.call<{ items?: CalendarEvent[]; nextPageToken?: string }>('GET', this.cal(), { query });
      out.push(...(j.items ?? []));
      pageToken = j.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }
}

/** The email address inside Google's id_token. It comes straight from Google over TLS, so it isn't re-verified. */
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}
