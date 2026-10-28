import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Secrets } from '../ai/settings.js';
import { EXTENSION_PATH } from './security.js';
import { lastUnitrustSync, recordUnitrustEvents } from '../domain/unitrustAppointments.js';

// The Unitrust extension: it posts the appointments it sees on the Unitrust calendar (with its own key, see
// security.ts), and Settings shows that key and what the last sync found.

const events = z.object({
  events: z
    .array(
      z.object({
        title: z.string().max(300),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
        color: z.enum(['blue', 'green', 'red', 'yellow']),
      }),
    )
    .max(2000),
});

export function registerUnitrustRoutes(app: FastifyInstance, deps: { db: DB; secrets: Secrets }) {
  const { db, secrets } = deps;

  app.post(EXTENSION_PATH, async (req) => recordUnitrustEvents(db, events.parse(req.body).events));

  app.get('/api/unitrust', async () => ({ key: secrets.get('unitrust_extension_key'), last_sync: lastUnitrustSync(db) }));

  // A new key: the extension needs it pasted in again, and the old one stops working.
  app.post('/api/unitrust/key', async () => {
    const key = randomBytes(18).toString('base64url');
    secrets.set('unitrust_extension_key', key);
    return { key };
  });
}
