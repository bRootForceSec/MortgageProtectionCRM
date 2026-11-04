import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Secrets } from '../ai/settings.js';
import { EXTENSION_PATH, EXTENSION_POLICIES_PATH } from './security.js';
import { lastUnitrustSync, recordUnitrustEvents } from '../domain/unitrustAppointments.js';
import {
  compLevels, deleteCompLevel, lastPolicySync, linkPolicy, listPolicies, listProducts, recordUnitrustPolicies, saveProduct, setCompLevel,
} from '../domain/policies.js';
import { PRODUCT_KINDS } from '../../shared/policies.js';

// The Unitrust extension: it posts the appointments it sees on the Unitrust calendar and the policies on the Business
// Management Report (with its own key, see security.ts), and Settings shows that key and what the last sync found.
// Also the products and comp level those policies are worked out with, and linking a policy to a lead.

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
  /** Today on your computer, and the days the calendar showed (for telling reschedules apart). */
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(62).optional(),
});

const text = (n: number) => z.string().max(n).nullish();
const policies = z.object({
  policies: z
    .array(
      z.object({
        app_id: z.string().min(1).max(60),
        policy_number: text(60),
        client_name: text(200),
        client_phone: text(40),
        carrier: z.string().min(1).max(120),
        product: z.string().min(1).max(200),
        premium: text(40),
        apv: text(40),
        capped_apv: text(40),
        status: text(80),
        applied: text(20),
        submitted: text(20),
        paid: text(20),
        lapsed: text(20),
      }),
    )
    .max(2000),
  /** Your comp level, when the page shows it ("Lv. 70"). */
  level: z.number().min(0).max(200).nullish(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const points = z.number().min(-100).max(200).nullable();

export function registerUnitrustRoutes(app: FastifyInstance, deps: { db: DB; secrets: Secrets }) {
  const { db, secrets } = deps;

  app.post(EXTENSION_PATH, async (req) => {
    const b = events.parse(req.body);
    return recordUnitrustEvents(db, b.events, { today: b.today, days: b.days });
  });

  app.post(EXTENSION_POLICIES_PATH, async (req) => recordUnitrustPolicies(db, policies.parse(req.body)));

  app.get('/api/unitrust', async () => ({
    key: secrets.get('unitrust_extension_key'), last_sync: lastUnitrustSync(db), last_policy_sync: lastPolicySync(db),
  }));

  app.get('/api/products', async () => ({ products: listProducts(db), levels: compLevels(db) }));

  app.put('/api/products/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({
      kind: z.enum(PRODUCT_KINDS.map((k) => k.key) as [string, ...string[]]).nullable().optional(),
      comp_hit_points: points.optional(),
      advance_pct: z.number().min(0).max(100).nullable().optional(),
    }).parse(req.body);
    return saveProduct(db, id, b as Parameters<typeof saveProduct>[2]);
  });

  app.post('/api/comp-levels', async (req) => {
    const b = z.object({ level: z.number().min(0).max(200), effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body);
    return { levels: setCompLevel(db, b.level, b.effective_from) };
  });

  app.delete('/api/comp-levels/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    return { levels: deleteCompLevel(db, id) };
  });

  // A lead's policies, or the ones with no lead (to link by hand).
  app.get('/api/policies', async (req) => {
    const q = z.object({ lead: z.string().max(64).optional(), unlinked: z.enum(['1']).optional() }).parse(req.query);
    return { policies: listPolicies(db, { leadId: q.lead, unlinked: !!q.unlinked }) };
  });

  app.put('/api/policies/:id/lead', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const { lead_id } = z.object({ lead_id: z.string().max(64).nullable() }).parse(req.body);
    linkPolicy(db, id, lead_id);
    return { ok: true };
  });

  // A new key: the extension needs it pasted in again, and the old one stops working.
  app.post('/api/unitrust/key', async () => {
    const key = randomBytes(18).toString('base64url');
    secrets.set('unitrust_extension_key', key);
    return { key };
  });
}
