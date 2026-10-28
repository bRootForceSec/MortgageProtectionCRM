import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { DomainError } from '../core/errors.js';
import { parseList } from '../domain/groupFilter.js';
import { buildReport, drill, DrillSpec, loadTargets, reportCalls, reportJson, reportSheets, saveTargets, type ReportFilter, todayStats } from '../domain/reports.js';
import { toCsv, toXlsx } from '../domain/exporter.js';

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

export function registerReportRoutes(app: FastifyInstance, deps: { db: DB }) {
  const { db } = deps;

  // ---------- reports ----------
  app.get('/api/reports', async (req) => buildReport(db, toFilter(filterQuery.parse(req.query))));

  app.get('/api/reports/drill', async (req) => {
    const q = filterQuery.extend(DrillSpec.shape).parse(req.query);
    return drill(db, toFilter(q), { section: q.section, key: q.key, metric: q.metric });
  });

  app.get('/api/reports/export.xlsx', async (req, reply) => {
    const f = toFilter(filterQuery.parse(req.query));
    const buf = await toXlsx(reportSheets(buildReport(db, f), reportCalls(db, f)));
    return reply
      .header('content-disposition', `attachment; filename="report-${f.from.slice(0, 10)}.xlsx"`)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(buf);
  });

  // Every call in the range, one row each, for another system or a spreadsheet.
  app.get('/api/reports/calls.csv', async (req, reply) => {
    const f = toFilter(filterQuery.parse(req.query));
    return reply
      .header('content-disposition', `attachment; filename="report-calls-${f.from.slice(0, 10)}.csv"`)
      .type('text/csv')
      .send(toCsv(reportCalls(db, f)));
  });

  // The whole report plus its calls, for another system or for analysis.
  app.get('/api/reports/export.json', async (req, reply) => {
    const f = toFilter(filterQuery.parse(req.query));
    return reply
      .header('content-disposition', `attachment; filename="report-${f.from.slice(0, 10)}.json"`)
      .type('application/json')
      .send(JSON.stringify(reportJson(db, f), null, 2));
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

  app.get('/api/stats/today', async (req) => {
    const q = z.object({ from: z.string().max(40), to: z.string().max(40), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    return todayStats(db, q.from, q.to, q.day);
  });
}
