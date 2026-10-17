import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { DomainError, voidCall } from '../domain/calls.js';
import { loadCallingSettings, saveCallingSettings, SHORTCUT_ACTIONS } from '../domain/callingSettings.js';
import { rebuildLeadState } from '../domain/leadState.js';
import { KdeConnect } from '../dialer.js';
import { groupWhere, parseList } from '../domain/groupFilter.js';
import { cancelAppointment, type CalendarWorker } from '../calendar/sync.js';

const idParam = z.object({ id: z.string().max(64) });

export function registerCallingRoutes(app: FastifyInstance, deps: { db: DB; kde?: KdeConnect; calendar?: CalendarWorker }) {
  const { db } = deps;
  const kde = deps.kde ?? new KdeConnect();

  // ---------- settings for the Calling screen ----------
  app.get('/api/settings/calling', async () => ({
    settings: loadCallingSettings(db),
    actions: SHORTCUT_ACTIONS,
  }));

  app.put('/api/settings/calling', async (req) => {
    const before = loadCallingSettings(db);
    let saved;
    try {
      saved = saveCallingSettings(db, req.body);
    } catch (e: any) {
      if (e instanceof z.ZodError) throw e;
      throw new DomainError(e.message);
    }
    // A new retry gap changes when every unanswered lead comes back.
    if (saved.retry_gap_minutes !== before.retry_gap_minutes) rebuildLeadState(db);
    return { settings: saved, actions: SHORTCUT_ACTIONS };
  });

  // ---------- undo ----------
  app.post('/api/calls/:id/void', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ reason: z.string().max(500).nullish() }).parse(req.body ?? {});
    const res = db.transaction(() => {
      const r = voidCall(db, id, b.reason);
      // Take the #MP event back off the calendar. If Unitrust already booked it, only Unitrust can cancel it.
      const appt = db.prepare('SELECT id FROM appointment WHERE set_on_call_id = ?').get(id) as { id: string } | undefined;
      const cal = appt ? cancelAppointment(db, appt.id) : { unitrust_has_it: false };
      return { ...r, calendar_unitrust_has_it: cal.unitrust_has_it };
    })();
    deps.calendar?.kick();
    return res;
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

  // ---------- agenda: callbacks and appointments ----------
  app.get('/api/agenda', async (req) => {
    const q = z.object({
      from: z.string().max(40),
      to: z.string().max(40),
      counties: z.string().max(4000).optional(),
      area_codes: z.string().max(400).optional(),
    }).parse(req.query);
    const group = groupWhere('l.county_key', { counties: parseList(q.counties), areaCodes: parseList(q.area_codes) });
    const name = `trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,''))`;
    // Callbacks still due before the end of the range, including ones you missed earlier and ones with no time yet.
    const callbacks = db
      .prepare(
        `SELECT l.id lead_id, ${name} name, l.phone_e164, l.time_zone, l.county, l.state, s.next_due_at due_at
         FROM lead_state s JOIN lead l ON l.id = s.lead_id
         WHERE s.status = 'callback' AND (s.next_due_at IS NULL OR s.next_due_at < @to) AND ${group.sql}
         ORDER BY s.next_due_at IS NULL, s.next_due_at`,
      )
      .all({ to: q.to, ...group.params });
    const appointments = db
      .prepare(
        `SELECT a.id, a.lead_id, ${name} name, l.phone_e164, l.time_zone, l.county, l.state, a.scheduled_for, a.notes,
           cs.state calendar_state, cs.unitrust_url
         FROM appointment a JOIN lead l ON l.id = a.lead_id JOIN lead_state s ON s.lead_id = l.id
         LEFT JOIN calendar_sync cs ON cs.appointment_id = a.id
         WHERE a.internal_status <> 'canceled' AND a.official_status IS NULL
           AND ((a.scheduled_for >= @from AND a.scheduled_for < @to) OR (a.scheduled_for IS NULL AND s.status = 'appointment_set'))
           AND ${group.sql}
         ORDER BY a.scheduled_for IS NULL, a.scheduled_for`,
      )
      .all({ from: q.from, to: q.to, ...group.params });
    return { callbacks, appointments };
  });
}
