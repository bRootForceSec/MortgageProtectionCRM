import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { voidCall } from '../domain/calls.js';
import { DomainError } from '../core/errors.js';
import { loadCallingSettings, saveCallingSettings, SHORTCUT_ACTIONS } from '../domain/callingSettings.js';
import { rebuildLeadState } from '../domain/leadState.js';
import { KdeConnect } from '../dialer.js';
import { parseList } from '../domain/groupFilter.js';
import { callbacksDue } from '../domain/callList.js';

const idParam = z.object({ id: z.string().max(64) });

export function registerCallingRoutes(app: FastifyInstance, deps: { db: DB; kde?: KdeConnect }) {
  const { db } = deps;
  const kde = deps.kde ?? new KdeConnect();

  // ---------- settings for the Calling screen ----------
  app.get('/api/settings/calling', async () => ({
    settings: loadCallingSettings(db),
    actions: SHORTCUT_ACTIONS,
  }));

  app.put('/api/settings/calling', async (req) => {
    const before = loadCallingSettings(db);
    const saved = saveCallingSettings(db, req.body);
    // A new retry gap changes when every unanswered lead comes back.
    if (saved.retry_gap_minutes !== before.retry_gap_minutes) rebuildLeadState(db);
    return { settings: saved, actions: SHORTCUT_ACTIONS };
  });

  // ---------- undo ----------
  app.post('/api/calls/:id/void', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ reason: z.string().max(500).nullish() }).parse(req.body ?? {});
    return voidCall(db, id, b.reason);
  });

  // ---------- dial from the computer (KDE Connect) ----------
  app.get('/api/dial/devices', async () => {
    try {
      return { ok: true, devices: await kde.devices() };
    } catch (e: any) {
      return { ok: false, error: e.message, devices: [] };
    }
  });

  app.post('/api/dial', async (req) => {
    const b = z.object({ to_e164: z.string().regex(/^\+1\d{10}$/), device_id: z.string().max(100).nullish() }).parse(req.body);
    const device = b.device_id || loadCallingSettings(db).kdeconnect_device;
    if (!device) throw new DomainError('choose your phone under Settings → Calling first');
    try {
      await kde.dial(device, b.to_e164);
    } catch (e: any) {
      throw new DomainError(e.message, 502);
    }
    return { ok: true };
  });

  // ---------- agenda: callbacks (appointments live in Unitrust) ----------
  app.get('/api/agenda', async (req) => {
    const q = z.object({
      from: z.string().max(40),
      to: z.string().max(40),
      counties: z.string().max(4000).optional(),
      area_codes: z.string().max(400).optional(),
    }).parse(req.query);
    return { callbacks: callbacksDue(db, q.to, { counties: parseList(q.counties), areaCodes: parseList(q.area_codes) }) };
  });
}
