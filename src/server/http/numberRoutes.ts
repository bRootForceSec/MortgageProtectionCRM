import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { DomainError } from '../core/errors.js';
import { listNumbers, addNumber, updateNumber, numberStats, numberChecks, recordNumberCheck } from '../domain/numbers.js';

// Caller ID numbers: the list, how each is doing, and the reputation checks.

const idParam = z.object({ id: z.string().max(64) });

export function registerNumberRoutes(app: FastifyInstance, deps: { db: DB }) {
  const { db } = deps;

  // ---------- caller ID numbers ----------
  app.get('/api/numbers', async () => listNumbers(db));

  app.post('/api/numbers', async (req) => {
    const b = z.object({ number: z.string().max(40), label: z.string().max(60).nullish(), notes: z.string().max(1000).nullish() }).parse(req.body);
    return addNumber(db, b);
  });

  app.post('/api/numbers/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({
      label: z.string().max(60).nullish(),
      status: z.enum(['active', 'standby', 'retired']).optional(),
      retire_reason: z.string().max(500).nullish(),
      reputation_status: z.enum(['unchecked', 'clear', 'flagged', 'investigating']).optional(),
      notes: z.string().max(1000).nullish(),
    }).parse(req.body);
    updateNumber(db, id, b);
    return { ok: true };
  });

  // ---------- caller ID numbers ----------
  app.get('/api/numbers/stats', async (req) => {
    const q = z.object({ today_from: z.string().max(40) }).parse(req.query);
    if (Number.isNaN(Date.parse(q.today_from))) throw new DomainError('bad date');
    return numberStats(db, q.today_from);
  });
  app.get('/api/numbers/:id/checks', async (req) => numberChecks(db, idParam.parse(req.params).id));
  app.post('/api/numbers/:id/checks', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({
        item: z.string().max(60),
        checked_on: z.string().max(10).nullable(),
        result: z.enum(['ok', 'problem']).nullish(),
        note: z.string().max(1000).nullish(),
      })
      .parse(req.body);
    return recordNumberCheck(db, id, { ...b, result: b.result ?? null });
  });
}
