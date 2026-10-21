import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import { DomainError } from '../core/errors.js';
import { parseList } from '../domain/groupFilter.js';
import { buildReport, drill, DrillSpec, loadTargets, reportSheets, saveTargets, type ReportFilter } from '../domain/reports.js';
import { toXlsx } from '../domain/exporter.js';
import { numberChecks, numberStats, recordNumberCheck } from '../domain/numbers.js';
import { checkLatestBackup, type RestoreCheck } from '../backup.js';
import { getSetting, setSetting } from '../ai/settings.js';

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

export function registerReportRoutes(app: FastifyInstance, deps: { db: DB; config: Config }) {
  const { db, config } = deps;

  // ---------- reports ----------
  app.get('/api/reports', async (req) => buildReport(db, toFilter(filterQuery.parse(req.query))));

  app.get('/api/reports/drill', async (req) => {
    const q = filterQuery.extend(DrillSpec.shape).parse(req.query);
    return drill(db, toFilter(q), { section: q.section, key: q.key, metric: q.metric });
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
      if (e instanceof z.ZodError) throw new DomainError('targets must be between 0% and 100%');
      throw e;
    }
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

  // ---------- backup restore check ----------
  app.get('/api/backups/check', async () => getSetting<RestoreCheck>(db, RESTORE_CHECK));
  app.post('/api/backups/check', async () => {
    const r = checkLatestBackup(config);
    if (r.file) setSetting(db, RESTORE_CHECK, r);
    return r;
  });
}
