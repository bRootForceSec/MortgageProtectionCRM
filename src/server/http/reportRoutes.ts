import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import { DomainError } from '../domain/calls.js';
import { parseList, groupWhere } from '../domain/groupFilter.js';
import { buildReport, drill, DrillSpec, loadTargets, reportSheets, saveTargets, type ReportFilter } from '../domain/reports.js';
import { toXlsx } from '../domain/exporter.js';
import { APPOINTMENT_RESULTS, appointmentResults, recordAppointmentResult } from '../domain/appointments.js';
import { CURRENT_RESULT_SQL } from '../domain/leadState.js';
import { numberChecks, numberStats, recordNumberCheck } from '../domain/numbers.js';
import { checkLatestBackup, type RestoreCheck } from '../backup.js';
import { getSetting, setSetting } from '../ai/settings.js';
import { rescheduleAppointment, type CalendarWorker } from '../calendar/sync.js';

const idParam = z.object({ id: z.string().max(64) });
const filterQuery = z.object({
  from: z.string().max(40),
  to: z.string().max(40),
  tz: z.string().max(80).default('UTC'),
  counties: z.string().max(4000).optional(),
  area_codes: z.string().max(400).optional(),
});

function toFilter(q: z.infer<typeof filterQuery>): ReportFilter {
  if (Number.isNaN(Date.parse(q.from)) || Number.isNaN(Date.parse(q.to))) throw new DomainError('pick a valid date range');
  let tz = q.tz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  return { from: q.from, to: q.to, tz, counties: parseList(q.counties), areaCodes: parseList(q.area_codes) };
}

export const RESTORE_CHECK = 'backup_restore_check';
const WEEK = 7 * 86_400_000;

/** Runs the backup restore check if the last one is a week old (or there's a newer backup that has never been checked). */
export function runBackupCheckIfDue(db: DB, config: Config, now = new Date()): RestoreCheck | null {
  const last = getSetting<RestoreCheck>(db, RESTORE_CHECK);
  if (last && now.getTime() - Date.parse(last.at) < WEEK) return null;
  const r = checkLatestBackup(config, now);
  if (r.file) setSetting(db, RESTORE_CHECK, r);
  return r;
}

export function registerReportRoutes(app: FastifyInstance, deps: { db: DB; config: Config; calendar?: CalendarWorker }) {
  const { db, config } = deps;

  // ---------- reports ----------
  app.get('/api/reports', async (req) => buildReport(db, toFilter(filterQuery.parse(req.query))));

  app.get('/api/reports/drill', async (req) => {
    const q = filterQuery.extend(DrillSpec.shape).parse(req.query);
    try {
      return drill(db, toFilter(q), { section: q.section, key: q.key, metric: q.metric });
    } catch (e: any) {
      throw new DomainError(e.message);
    }
  });

  app.get('/api/reports/export.xlsx', async (req, reply) => {
    const f = toFilter(filterQuery.parse(req.query));
    const buf = await toXlsx(reportSheets(buildReport(db, f)));
    return reply
      .header('content-disposition', `attachment; filename="report-${f.from.slice(0, 10)}.xlsx"`)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(buf);
  });

  app.get('/api/reports/targets', async () => loadTargets(db));
  app.put('/api/reports/targets', async (req) => {
    try {
      return saveTargets(db, req.body);
    } catch (e: any) {
      if (e?.issues) throw new DomainError('targets must be between 0% and 100%');
      throw e;
    }
  });

  // ---------- appointment results ----------
  /** Appointments whose time has passed (or that have no date) and that you haven't said how they went. */
  app.get('/api/appointments/results-due', async (req) => {
    const q = z.object({ counties: z.string().max(4000).optional(), area_codes: z.string().max(400).optional() }).parse(req.query);
    const g = groupWhere('l.county_key', { counties: parseList(q.counties), areaCodes: parseList(q.area_codes) });
    return db
      .prepare(
        `SELECT a.id, a.lead_id, a.scheduled_for, a.notes, a.recorded_via,
                trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) name, l.phone_e164, l.time_zone, l.county, l.state
         FROM appointment a JOIN lead l ON l.id = a.lead_id LEFT JOIN call c ON c.id = a.set_on_call_id
         WHERE a.internal_status <> 'canceled' AND (c.id IS NULL OR c.voided_at IS NULL)
           AND (a.scheduled_for IS NULL OR a.scheduled_for < @now) AND ${CURRENT_RESULT_SQL} IS NULL
           AND ${g.sql}
         ORDER BY a.scheduled_for IS NULL, a.scheduled_for DESC`,
      )
      .all({ now: new Date().toISOString(), ...g.params });
  });

  app.post('/api/appointments/:id/result', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({
        result: z.enum([...APPOINTMENT_RESULTS, 'cleared']),
        rescheduled_for: z.string().max(40).nullish(),
        note: z.string().max(2000).nullish(),
      })
      .parse(req.body);
    const r = db.transaction(() => {
      const res = recordAppointmentResult(db, id, b);
      // A new time gets its own #MP event with the same note, when the old one was on the calendar.
      if (res.new_appointment_id) rescheduleAppointment(db, id, res.new_appointment_id);
      return res;
    })();
    if (r.new_appointment_id) deps.calendar?.kick();
    return r;
  });

  app.get('/api/appointments/:id/results', async (req) => appointmentResults(db, idParam.parse(req.params).id));

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

  // ---------- backup restore check ----------
  app.get('/api/backups/check', async () => getSetting<RestoreCheck>(db, RESTORE_CHECK));
  app.post('/api/backups/check', async () => {
    const r = checkLatestBackup(config);
    if (r.file) setSetting(db, RESTORE_CHECK, r);
    return r;
  });
}
