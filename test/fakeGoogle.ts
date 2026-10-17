import type { CalendarEvent, GoogleEndpoints } from '../src/server/calendar/google.js';

// A pretend Google: sign-in and the Calendar calls the app makes, kept in memory. No network.

export const FAKE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://fake-google/auth',
  token: 'https://fake-google/token',
  api: 'https://fake-google/calendar/v3',
  revoke: 'https://fake-google/revoke',
};

export class FakeGoogle {
  events = new Map<string, CalendarEvent & { updated: string }>();
  calls: { method: string; path: string; query: Record<string, string>; body: any }[] = [];
  offline = false;
  /** The refresh token Google accepts; anything else is invalid_grant. */
  validRefresh = 'refresh-1';
  /** Make the next calls to this path fail with the given status. */
  failNext: { status: number; method?: string; count: number } | null = null;
  /** Act as if Google ignores description edits (the event belongs to someone else). */
  ignoreDescriptionEdits = false;
  private clock = 0;

  /** Unitrust replacing our #MP event with its own. */
  unitrustReplaces(ourId: string, opts: { leadId: string; borrower: string; html?: boolean; startShiftMin?: number; id?: string } ) {
    const ours = this.events.get(ourId)!;
    this.events.delete(ourId);
    const lines = [
      'App_Management: https://myunitrust.com/app_mng/1792075936516x748922075734196600',
      `LEAD ID: ${opts.leadId}`,
      `BORROWER: ${opts.borrower}`,
      'ADDRESS: 17233 PLATTER PKWY',
      'CITY: NEW HAVEN',
      'STATE: IN',
      'ZIP: ',
      '',
      'PHONE: (260) 699-1123',
      'BENEFICIARY:',
    ];
    const start = new Date(Date.parse(ours.start!.dateTime!) + (opts.startShiftMin ?? 0) * 60_000).toISOString();
    const ev: CalendarEvent & { updated: string } = {
      id: opts.id ?? `unitrust${this.events.size + 1}`,
      status: 'confirmed',
      summary: ours.summary,
      description: opts.html ? lines.join('<br>') : lines.join('\n'),
      start: { dateTime: start },
      end: { dateTime: new Date(Date.parse(start) + 30 * 60_000).toISOString() },
      attendees: [{ email: 'borrower@example.com' }],
      updated: this.stamp(),
    };
    this.events.set(ev.id, ev);
    return ev;
  }

  rewrite(id: string, description: string) {
    const ev = this.events.get(id)!;
    ev.description = description;
    ev.updated = this.stamp();
  }

  private stamp() {
    this.clock += 1;
    return new Date(Date.now() + this.clock).toISOString();
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (this.offline) throw new TypeError('fetch failed');
    const body = init?.body;
    if (url.href.startsWith(FAKE_ENDPOINTS.token)) {
      const p = new URLSearchParams(String(body));
      if (p.get('client_secret') !== 'secret-1') return json(401, { error: 'invalid_client', error_description: 'Unauthorized' });
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'good-code' || !p.get('code_verifier')) return json(400, { error: 'invalid_grant' });
        const idToken = `x.${Buffer.from(JSON.stringify({ email: 'agent@gmail.com' })).toString('base64url')}.y`;
        return json(200, { access_token: 'access-1', expires_in: 3599, refresh_token: this.validRefresh, scope: 'openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email', id_token: idToken });
      }
      if (p.get('refresh_token') !== this.validRefresh) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return json(200, { access_token: 'access-2', expires_in: 3599 });
    }
    if (url.href.startsWith(FAKE_ENDPOINTS.revoke)) return json(200, {});
    const path = url.pathname.replace('/calendar/v3', '');
    const query = Object.fromEntries(url.searchParams);
    const parsed = body ? JSON.parse(String(body)) : undefined;
    this.calls.push({ method, path, query, body: parsed });
    if (this.failNext && this.failNext.count > 0 && (!this.failNext.method || this.failNext.method === method)) {
      this.failNext.count--;
      return json(this.failNext.status, { error: { message: `fake error ${this.failNext.status}` } });
    }
    const m = path.match(/^\/calendars\/primary\/events(?:\/([^/]+))?$/);
    if (!m) return json(404, { error: { message: 'not found' } });
    const id = m[1] ? decodeURIComponent(m[1]) : null;
    if (method === 'POST' && !id) {
      if (this.events.has(parsed.id)) return json(409, { error: { message: 'The requested identifier already exists.' } });
      const ev = { ...parsed, status: 'confirmed', updated: this.stamp() };
      this.events.set(parsed.id, ev);
      return json(200, ev);
    }
    if (method === 'GET' && !id) {
      const tMin = Date.parse(query.timeMin!);
      const tMax = Date.parse(query.timeMax!);
      const items = [...this.events.values()].filter((e) => {
        const s = Date.parse(e.start!.dateTime!);
        return s < tMax && Date.parse(e.end!.dateTime!) > tMin && (!query.updatedMin || e.updated >= query.updatedMin);
      });
      return json(200, { items });
    }
    const ev = id ? this.events.get(id) : undefined;
    if (!ev) return json(404, { error: { message: 'Not Found' } });
    if (method === 'GET') return json(200, ev);
    if (method === 'DELETE') {
      this.events.delete(id!);
      return new Response(null, { status: 204 });
    }
    if (method === 'PATCH') {
      const { description, ...rest } = parsed;
      Object.assign(ev, rest);
      if (description !== undefined && !this.ignoreDescriptionEdits) ev.description = description;
      ev.updated = this.stamp();
      return json(200, ev);
    }
    return json(405, { error: { message: 'method' } });
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
