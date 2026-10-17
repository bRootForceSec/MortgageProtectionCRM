import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import { DomainError } from '../domain/calls.js';
import { GoogleApiError, GoogleAuthError, type GoogleCalendar } from '../calendar/google.js';
import { calendarProblems, changeNote, retry, useUnitrustTime, type CalendarWorker } from '../calendar/sync.js';

const idParam = z.object({ id: z.string().max(64) });

export const OAUTH_CALLBACK_PATH = '/oauth/google/callback';

export function redirectUri(config: Config) {
  return `http://127.0.0.1:${config.port}${OAUTH_CALLBACK_PATH}`;
}

export function registerCalendarRoutes(app: FastifyInstance, deps: { db: DB; config: Config; google: GoogleCalendar; worker: CalendarWorker }) {
  const { db, config, google, worker } = deps;

  const status = () => {
    const s = google.settings();
    const counts = Object.fromEntries(
      (db.prepare('SELECT state, count(*) n FROM calendar_sync GROUP BY state').all() as { state: string; n: number }[]).map((r) => [r.state, r.n]),
    );
    return {
      configured: google.configured(),
      connected: google.connected(),
      client_id: s.client_id,
      email: s.email,
      connected_at: s.connected_at,
      needs_reconnect: s.needs_reconnect,
      reconnect_reason: s.reconnect_reason,
      last_connect_error: google.lastConnectError,
      last_error: worker.lastError,
      last_run_at: worker.lastRunAt,
      redirect_uri: redirectUri(config),
      problems: calendarProblems(db),
      counts,
    };
  };

  app.get('/api/calendar', async () => status());

  app.put('/api/calendar/client', async (req) => {
    const b = z.object({ client_id: z.string().max(300), client_secret: z.string().max(300).nullish() }).parse(req.body);
    if (b.client_id.trim() && !/\.apps\.googleusercontent\.com$/.test(b.client_id.trim())) {
      throw new DomainError('The client ID ends in .apps.googleusercontent.com. Copy it from the Google Cloud page again.');
    }
    google.saveClient(b.client_id, b.client_secret ?? null);
    return status();
  });

  /** Returns the Google sign-in link; the page then goes there. */
  app.post('/api/calendar/connect', async () => {
    if (!google.configured()) throw new DomainError('Save the client ID and secret first.');
    google.lastConnectError = null;
    return { url: google.startAuth(redirectUri(config)) };
  });

  // Google sends the browser here after sign-in. Not under /api (no access cookie needed): the one-time `state`
  // from the sign-in this app started is the proof, and an unknown state is refused.
  app.get(OAUTH_CALLBACK_PATH, async (req, reply) => {
    const q = z.object({ state: z.string().max(200).optional(), code: z.string().max(2000).optional(), error: z.string().max(200).optional() }).parse(req.query);
    if (!q.state || !google.knowsState(q.state)) {
      return reply.code(400).type('text/plain').send('This sign-in link is not from this app, or it was already used. Go back to the CRM and click Connect again.');
    }
    if (q.error || !q.code) {
      google.lastConnectError = q.error === 'access_denied' ? 'You cancelled the Google sign-in.' : `Google sign-in failed: ${q.error ?? 'no code'}`;
      google.dropState(q.state);
    } else {
      try {
        await google.finishAuth(q.state, q.code);
        worker.kick();
      } catch (e: any) {
        google.lastConnectError = e.message;
      }
    }
    return reply.redirect('/#settings', 303);
  });

  app.post('/api/calendar/disconnect', async () => {
    await google.disconnect();
    return status();
  });

  /** Checks the connection by reading one event. Changes nothing on the calendar. */
  app.post('/api/calendar/check', async () => {
    if (!google.connected()) return { ok: false, message: 'Not connected.' };
    try {
      const now = new Date();
      await google.listEvents({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 86400_000).toISOString() });
      return { ok: true, message: `Connected${google.settings().email ? ` as ${google.settings().email}` : ''}. The app can read and add events on your main calendar.` };
    } catch (e: any) {
      if (e instanceof GoogleAuthError) return { ok: false, message: `Google no longer accepts the sign-in (${e.message}). Click Connect again.` };
      if (e instanceof GoogleApiError) return { ok: false, message: e.message };
      throw e;
    }
  });

  app.put('/api/calendar/appointments/:id/note', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ note: z.string().max(4000).nullable() }).parse(req.body);
    changeNote(db, id, b.note);
    worker.kick();
    return { ok: true };
  });

  app.post('/api/calendar/appointments/:id/retry', async (req) => {
    retry(db, idParam.parse(req.params).id);
    worker.kick();
    return { ok: true };
  });

  app.post('/api/calendar/appointments/:id/use-unitrust-time', async (req) => useUnitrustTime(db, idParam.parse(req.params).id));

  app.get('/api/calendar/appointments/:id/history', async (req) =>
    db.prepare('SELECT * FROM calendar_sync_event WHERE appointment_id = ? ORDER BY at, id').all(idParam.parse(req.params).id),
  );
}
