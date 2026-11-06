import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import { DomainError } from '../core/errors.js';
import type { GoogleCalendar } from '../domain/googleCalendar.js';

// Google Calendar (domain/googleCalendar.ts): your Google key, signing in, the calendar to use, and Sync now.
// GOOGLE_CALLBACK_PATH is where Google sends your browser back after signing in. That browser may not have the
// CRM's cookie (the desktop app opens your own browser), so security.ts lets it through; the one-time `state` from
// the sign-in the CRM started is what makes it safe.

export const GOOGLE_CALLBACK_PATH = '/api/google/callback';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
  `<body style="font: 16px system-ui, sans-serif; max-width: 560px; margin: 15vh auto; padding: 0 16px"><h1 style="font-size: 22px">${esc(title)}</h1><p>${esc(text)}</p></body>`;

export function registerGoogleRoutes(app: FastifyInstance, deps: { calendar: GoogleCalendar }) {
  const { calendar } = deps;

  app.get('/api/google', async () => calendar.status());

  app.put('/api/google/client', async (req) => {
    const b = z.object({ client_id: z.string().max(300), client_secret: z.string().max(300) }).parse(req.body);
    calendar.saveClient(b.client_id, b.client_secret);
    return calendar.status();
  });

  app.post('/api/google/connect', async () => ({ url: calendar.authUrl() }));

  app.get(GOOGLE_CALLBACK_PATH, async (req, reply) => {
    const q = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }).parse(req.query);
    reply.type('text/html; charset=utf-8');
    try {
      await calendar.finishSignIn(q.code, q.state, q.error);
      return page('Google Calendar is connected', 'You can close this tab and go back to the CRM. Your appointments go on your calendar in a moment.');
    } catch (e) {
      reply.code(e instanceof DomainError ? 400 : 502);
      return page("Google Calendar isn't connected", (e as Error).message);
    }
  });

  app.post('/api/google/disconnect', async () => {
    calendar.disconnect();
    return calendar.status();
  });

  app.get('/api/google/calendars', async () => ({ calendars: await calendar.calendars() }));

  app.put('/api/google/settings', async (req) => {
    calendar.saveSettings(req.body);
    return calendar.status();
  });

  app.post('/api/google/sync', async () => {
    const r = await calendar.sync();
    if (!r) throw new DomainError('connect Google and switch the calendar on first');
    return { result: r, status: calendar.status() };
  });
}
