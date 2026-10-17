import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

export const COOKIE = 'mpcrm_session';

// Local-only protections:
//  - the server binds to 127.0.0.1 (config.ts);
//  - Host must be 127.0.0.1/localhost on our port (blocks DNS-rebinding from web pages);
//  - every /api request needs the access-token cookie, which is set by opening the launch URL once;
//  - state-changing requests must come from our own Origin.

export function registerSecurity(app: FastifyInstance, opts: { token: string; port: number }) {
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host)) {
      return reply.code(421).type('text/plain').send('Unrecognized host');
    }

    // Launch URL: /?t=<token> sets the cookie and redirects to a clean URL.
    const url = new URL(req.url, `http://${host}`);
    const t = url.searchParams.get('t');
    if (t !== null) {
      if (!safeEqual(t, opts.token)) return reply.code(403).type('text/plain').send('Invalid access link');
      reply.header('set-cookie', `${COOKIE}=${opts.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      url.searchParams.delete('t');
      return reply.redirect(url.pathname + (url.search || ''), 303);
    }

    if (req.url.startsWith('/api/')) {
      if (!safeEqual(readCookie(req) ?? '', opts.token)) {
        return reply.code(401).send({ error: 'Open the app using the link printed when it started.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (!origin || !allowedOrigins.has(origin)) {
          return reply.code(403).send({ error: 'Cross-origin request blocked' });
        }
      }
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return payload;
  });
}

function readCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
