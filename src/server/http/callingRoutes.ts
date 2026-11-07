import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { voidCall } from '../domain/calls.js';
import { DomainError } from '../core/errors.js';
import { loadCallingSettings, loadOutcomeOverrides, saveCallingSettings, saveOutcomeOverrides } from '../domain/callingSettings.js';
import { SHORTCUT_ACTIONS } from '../../shared/callingSettings.js';
import { rebuildLeadState } from '../domain/leadState.js';
import { KdeConnect } from '../dialer.js';
import { parseList } from '../domain/groupFilter.js';
import { callbacksDue } from '../domain/callList.js';
import { appointmentsOnDay } from '../domain/appointments.js';
import { chooseRoutine, loadRoutines, routineToday, saveRoutines, startStep } from '../domain/routines.js';
import { loadRules, loadTagShortcuts, previewRule, ruleRuns, runRuleById, saveRules, saveTagShortcuts } from '../domain/rules.js';

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
    // A new retry gap or follow-up plan changes when leads come back.
    if (saved.retry_gap_minutes !== before.retry_gap_minutes || JSON.stringify(saved.follow_ups) !== JSON.stringify(before.follow_ups)) rebuildLeadState(db);
    return { settings: saved, actions: SHORTCUT_ACTIONS };
  });

  // ---------- your outcome names and buttons ----------
  app.get('/api/settings/outcomes', async () => ({ overrides: loadOutcomeOverrides(db) }));
  app.put('/api/settings/outcomes', async (req) => {
    const b = z.object({ overrides: z.unknown() }).parse(req.body);
    return { overrides: saveOutcomeOverrides(db, b.overrides) };
  });

  // ---------- rules (shared/rules.ts) ----------
  app.get('/api/rules', async () => ({ rules: loadRules(db) }));
  app.put('/api/rules', async (req) => ({ rules: saveRules(db, z.object({ rules: z.unknown() }).parse(req.body).rules) }));
  // What a rule (as edited, not yet saved) would do now. Changes nothing.
  // Tag shortcuts (take a tag off by itself; only one of a group at a time): each writes rules.
  app.get('/api/tag-shortcuts', async () => loadTagShortcuts(db));
  app.put('/api/tag-shortcuts', async (req) => saveTagShortcuts(db, req.body));
  app.post('/api/rules/preview', async (req) => previewRule(db, z.object({ rule: z.unknown() }).parse(req.body).rule));
  app.post('/api/rules/:id/run', async (req) => runRuleById(db, idParam.parse(req.params).id, false));
  app.get('/api/rules/runs', async (req) => {
    const q = z.object({ rule_id: z.string().max(64).optional(), all: z.enum(['1', '0']).optional() }).parse(req.query);
    return { runs: ruleRuns(db, { ruleId: q.rule_id, all: q.all === '1' }) };
  });

  // ---------- daily routines ----------
  app.get('/api/routines', async () => ({ routines: loadRoutines(db) }));
  app.put('/api/routines', async (req) => {
    const b = z.object({ routines: z.unknown() }).parse(req.body);
    return { routines: saveRoutines(db, b.routines) };
  });
  app.get('/api/routine/today', async () => routineToday(db));
  app.post('/api/routine/today', async (req) => chooseRoutine(db, z.object({ routine_id: z.string().max(64) }).parse(req.body).routine_id));
  app.post('/api/routine/steps/:id/start', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ mode: z.enum(['add', 'replace']), save_current_as: z.string().trim().max(120).nullish() }).parse(req.body);
    return startStep(db, id, b.mode, b.save_current_as || null);
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

  // ---------- agenda: callbacks, and the appointments of one day ----------
  app.get('/api/agenda', async (req) => {
    const q = z.object({
      from: z.string().max(40),
      to: z.string().max(40),
      counties: z.string().max(4000).optional(),
      area_codes: z.string().max(400).optional(),
      /** YYYY-MM-DD in your time: also send that day's appointments. */
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.query);
    return {
      callbacks: callbacksDue(db, q.to, { counties: parseList(q.counties), areaCodes: parseList(q.area_codes) }),
      appointments: q.day ? appointmentsOnDay(db, q.day) : [],
    };
  });
}
