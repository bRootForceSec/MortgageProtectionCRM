import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import { registerSecurity } from './security.js';
import { parseSpreadsheet, MAX_UPLOAD_BYTES, type ParsedFile } from '../domain/spreadsheet.js';
import { LEAD_FIELDS, suggestMapping } from '../domain/mapping.js';
import { savedMappingFor, MappingError } from '../domain/importer.js';
import { logManualCall, changeOutcome, addLeadAction, addNote, activeOutcomeCodes, callHistory } from '../domain/calls.js';
import { todayStats } from '../domain/reports.js';
import { DomainError } from '../core/errors.js';
import { exportRows, toCsv, toXlsx, fullJsonDump, EXPORT_TABLES, type ExportTable } from '../domain/exporter.js';
import { createBackup, listBackups } from '../backup.js';
import { uuidv7 } from '../ids.js';
import { listNumbers, addNumber, updateNumber } from '../domain/numbers.js';
import { listLeads, getLeadDetail, leadPdfPage, setLinkStatus } from '../domain/leads.js';
import { Updates } from '../updates.js';
import { registerImportRoutes, uploadHeader } from './importRoutes.js';
import { DraftWorker } from '../domain/drafts.js';
import { BulkImporter } from '../domain/bulkImport.js';
import { batchPdf, turnPdfPages, normTurn } from '../domain/pageTurn.js';
import { PageChecker } from '../domain/pageTurnFix.js';
import { makeReader } from '../ai/readers.js';
import { loadAiSettings } from '../ai/settings.js';
import { Secrets } from '../ai/settings.js';
import { registerCallingRoutes } from './callingRoutes.js';
import { registerReportRoutes } from './reportRoutes.js';
import { KdeConnect } from '../dialer.js';
import { parseList } from '../domain/groupFilter.js';
import {
  addMatchingToCallList, addToCallList, clearWorked, getCallList, moveToBottom,
  recentOutcomes, removeFromCallList, type LeadFilter, callListName, listSavedLists, clearCallList, loadSavedList, deleteSavedList, setCalledBack,
} from '../domain/callList.js';

export interface AppDeps {
  db: DB;
  config: Config;
  token: string;
  webDir?: string | null;
  logger?: boolean;
  /** Where logs go (defaults to stdout). Tests pass a buffer to check nothing sensitive is logged. */
  logStream?: NodeJS.WritableStream;
  /** Version info and the self-updater. Defaults to an unmanaged "dev" copy. */
  updates?: Updates;
  /** Reads PDF imports in the background. Defaults to one made here. */
  drafts?: DraftWorker;
  /** Bulk imports (many files at once). Defaults to one made here. */
  bulk?: BulkImporter;
  secrets?: Secrets;
  /** Sends numbers to your phone. Tests pass a fake. */
  kde?: KdeConnect;
  /** Turns lead pages upright in imported PDFs. Defaults to one made here. */
  pageChecker?: PageChecker;
}

interface Upload {
  parsed: ParsedFile;
  buf: Buffer;
  at: number;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, config } = deps;
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: deps.logger
      ? {
          level: 'info',
          ...(deps.logStream ? { stream: deps.logStream } : {}),
          // Never log query strings (the launch link carries the access token), bodies, or cookies.
          serializers: {
            req: (req) => ({ method: req.method, url: req.url.split('?')[0] }),
            res: (res) => ({ statusCode: res.statusCode }),
          },
        }
      : false,
  });

  registerSecurity(app, { token: deps.token, port: config.port });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof MappingError) return reply.code(400).send({ error: err.message, problems: err.problems });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid request', problems: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log?.error({ err: { message: err.message, stack: err.stack } }, 'request failed');
    return reply.code(500).send({ error: 'Something went wrong. Details are in the app log.' });
  });

  // ---------- uploads (kept in memory until committed; re-upload after a restart) ----------
  const uploads = new Map<string, Upload>();
  const getUpload = (id: string) => {
    const u = uploads.get(id);
    if (!u) throw new DomainError('upload expired; choose the file again', 410);
    return u;
  };
  const pruneUploads = () => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, u] of uploads) if (u.at < cutoff) uploads.delete(k);
    while (uploads.size > 5) uploads.delete(uploads.keys().next().value!);
  };

  const secrets = deps.secrets ?? Secrets.inDataDir(config.dataDir);
  const drafts = deps.drafts ?? new DraftWorker(db, secrets);
  const bulk = deps.bulk ?? new BulkImporter(db, config.importsDir, drafts);
  const pageChecker = deps.pageChecker ?? new PageChecker(db, config.importsDir, () => makeReader(loadAiSettings(db), secrets));
  registerImportRoutes(app, { db, config, worker: drafts, bulk, secrets, getUpload, dropUpload: (id) => uploads.delete(id) });
  registerCallingRoutes(app, { db, kde: deps.kde });
  registerReportRoutes(app, { db, config });

  // ---------- version & updates ----------
  const updates = deps.updates ?? new Updates(null, { commit: 'dev', built_at: null });
  // No token needed: the updater uses this to confirm the new version came up. It reveals only the version.
  app.get('/healthz', async () => ({ ok: true, commit: updates.build.commit, version: updates.build.version ?? null }));
  app.get('/api/update', async () => updates.status());
  app.post('/api/update/apply', async (_req, reply) => {
    try {
      await updates.apply();
    } catch (e: any) {
      throw new DomainError(e.message, 409);
    }
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/update/check', async (_req, reply) => {
    try {
      await updates.check();
    } catch (e: any) {
      throw new DomainError(e.message, 409);
    }
    return reply.code(202).send({ ok: true });
  });

  // ---------- meta ----------
  app.get('/api/meta', async () => ({
    outcome_codes: activeOutcomeCodes(db),
    lead_fields: LEAD_FIELDS.map(({ key, label }) => ({ key, label })),
    numbers: listNumbers(db),
    data_dir: config.dataDir,
    version: updates.build,
  }));

  // ---------- leads ----------
  const leadFilter = z.object({
    status: z.enum(['dead', 'invalid', 'appointment_set', 'callback', 'retry', 'no_answer', 'talked', 'new', 'all']).default('all'),
    search: z.string().max(100).optional(),
    batch_id: z.string().max(64).optional(),
    bulk_id: z.string().max(64).optional(),
    counties: z.string().max(4000).optional(),
    area_codes: z.string().max(400).optional(),
    tried_before: z.string().max(40).optional(),
    tried_after: z.string().max(40).optional(),
    not_on_list: z.union([z.boolean(), z.enum(['1', '0', 'true', 'false'])]).optional(),
  });
  const toFilter = (q: z.infer<typeof leadFilter>): LeadFilter => ({
    status: q.status,
    search: q.search,
    batch_id: q.batch_id || undefined,
    bulk_id: q.bulk_id || undefined,
    counties: parseList(q.counties),
    areaCodes: parseList(q.area_codes),
    tried_before: q.tried_before || undefined,
    tried_after: q.tried_after || undefined,
    not_on_list: q.not_on_list === true || q.not_on_list === '1' || q.not_on_list === 'true',
  });

  app.get('/api/leads', async (req) => listLeads(db, toFilter(leadFilter.parse(req.query))));

  // ---------- the call list ----------
  const savedName = z.string().trim().max(120);
  app.get('/api/call-list', async () => ({
    items: getCallList(db), recent: recentOutcomes(db), name: callListName(db), saved_lists: listSavedLists(db),
  }));
  // `replace` empties the list first (kept as a saved list named `save_current_as`, if given).
  const replaceOpts = z.object({ replace: z.boolean().optional(), save_current_as: savedName.nullish() });
  app.post('/api/call-list', async (req) => {
    const b = z.object({ lead_ids: z.array(z.string().max(64)).max(20_000) }).extend(replaceOpts.shape).parse(req.body);
    return db.transaction(() => {
      if (b.replace) clearCallList(db, b.save_current_as);
      return addToCallList(db, b.lead_ids);
    })();
  });
  app.post('/api/call-list/add-matching', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const o = replaceOpts.parse({ replace: body.replace, save_current_as: body.save_current_as });
    const f = toFilter(leadFilter.parse(body));
    return db.transaction(() => {
      if (o.replace) clearCallList(db, o.save_current_as);
      return addMatchingToCallList(db, f);
    })();
  });
  app.post('/api/call-list/clear-worked', async () => ({ removed: clearWorked(db) }));
  app.post('/api/call-list/clear', async (req) => {
    const b = z.object({ save_as: savedName.nullish() }).parse(req.body ?? {});
    return clearCallList(db, b.save_as);
  });
  app.post('/api/saved-lists/:id/load', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ save_current_as: savedName.nullish() }).parse(req.body ?? {});
    const r = loadSavedList(db, id, b.save_current_as);
    if (!r) throw new DomainError('that saved list is gone', 404);
    return r;
  });
  app.delete('/api/saved-lists/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    deleteSavedList(db, id);
    return { ok: true };
  });
  app.post('/api/call-list/:leadId/skip', async (req) => {
    const { leadId } = z.object({ leadId: z.string().max(64) }).parse(req.params);
    if (!moveToBottom(db, leadId)) throw new DomainError('that lead is not on the call list', 404);
    return { ok: true };
  });
  app.delete('/api/call-list/:leadId', async (req) => {
    const { leadId } = z.object({ leadId: z.string().max(64) }).parse(req.params);
    removeFromCallList(db, leadId);
    return { ok: true };
  });

  // The PDF a batch was imported from (kept as "<batch id>-<file name>" in the imports folder).
  app.get('/api/batches/:id/file', async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const file = batchPdf(config.importsDir, id);
    if (!file) throw new DomainError('the PDF for this batch is not on this computer', 404);
    return reply.type('application/pdf').send(fs.createReadStream(file));
  });

  // "Check all lead pages": goes through every imported PDF and turns sideways or upside-down pages upright.
  app.get('/api/lead-pages/check', async () => pageChecker.state);
  app.post('/api/lead-pages/check', async () => {
    void pageChecker.start(true);
    return pageChecker.state;
  });

  // Saves a turn of the lead's page in the batch PDF, so it shows the right way up from now on.
  app.post('/api/leads/:id/page-turn', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const { turn } = z.object({ turn: z.number().int() }).parse(req.body);
    const { file, page } = leadPdfPage(db, config.importsDir, id);
    const turned = await turnPdfPages(file, new Map([[page, normTurn(turn)]]));
    return { ok: true, turned };
  });

  app.get('/api/leads/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    return getLeadDetail(db, config.importsDir, id);
  });

  app.post('/api/leads/:id/calls', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({
      idempotency_key: z.string().min(8).max(100),
      from_number_id: z.string().max(64).nullish(),
      occurred_at: z.string().max(40).nullish(),
      talk_seconds: z.number().min(0).max(36000).nullish(),
      dial_count: z.number().int().min(1).max(1000).nullish(),
      lead_seconds: z.number().min(0).max(7 * 86400).nullish(),
      outcome_code: z.string().max(40),
      callback_due_at: z.string().max(40).nullish(),
      callback_any_time: z.boolean().nullish(),
      note: z.string().max(10000).nullish(),
    }).parse(req.body);
    return logManualCall(db, { ...b, lead_id: id });
  });

  app.post('/api/calls/:id/outcomes', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({
      outcome_code: z.string().max(40),
      expected_current_id: z.string().max(64).nullable(),
      callback_due_at: z.string().max(40).nullish(),
      callback_any_time: z.boolean().nullish(),
      note: z.string().max(10000).nullish(),
    }).parse(req.body);
    return changeOutcome(db, id, b);
  });

  app.post('/api/leads/:id/actions', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ action: z.enum(['skip', 'mark_dead', 'restore']), reason: z.string().max(500).nullish() }).parse(req.body);
    return addLeadAction(db, id, b.action, b.reason);
  });

  app.post('/api/leads/:id/called-back', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ on: z.boolean() }).parse(req.body);
    return { called_back_at: setCalledBack(db, id, b.on) };
  });

  app.post('/api/leads/:id/notes', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ body: z.string().max(10000), call_id: z.string().max(64).nullish() }).parse(req.body);
    return addNote(db, id, b.body, b.call_id);
  });

  app.post('/api/lead-links/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ status: z.enum(['suggested', 'same_person', 'different_person']) }).parse(req.body);
    setLinkStatus(db, id, b.status);
    return { ok: true };
  });

  // ---------- call history ----------
  app.get('/api/calls', async (req) => {
    const q = z.object({
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      outcome: z.string().max(40).optional(),
      search: z.string().max(100).optional(),
      counties: z.string().max(4000).optional(),
      area_codes: z.string().max(400).optional(),
    }).parse(req.query);
    return callHistory(db, { ...q, counties: parseList(q.counties), areaCodes: parseList(q.area_codes) });
  });

  app.get('/api/stats/today', async (req) => {
    const q = z.object({ from: z.string().max(40), to: z.string().max(40) }).parse(req.query);
    return todayStats(db, q.from, q.to);
  });

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

  // ---------- imports ----------
  app.post('/api/imports/parse', async (req) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) throw new DomainError('empty file');
    const name = uploadHeader(req.headers, 'x-file-name', 'upload.xlsx').replace(/[/\\]/g, '_').slice(0, 200);
    let parsed: ParsedFile;
    try {
      parsed = await parseSpreadsheet(buf, name);
    } catch (e: any) {
      throw new DomainError(e.message?.startsWith('Unsupported') ? e.message : `Could not read this file: ${e.message}`);
    }
    if (!parsed.sheets.length) throw new DomainError('no data found in this file');
    pruneUploads();
    const uploadId = uuidv7();
    uploads.set(uploadId, { parsed, buf, at: Date.now() });
    return {
      upload_id: uploadId,
      file_name: name,
      file_previously_imported: db.prepare('SELECT id, name, imported_at FROM import_batch WHERE file_sha256 = ?').all(parsed.sha256),
      sheets: parsed.sheets.map((s) => {
        const saved = savedMappingFor(db, s.headers);
        return {
          name: s.name,
          headers: s.headers,
          header_row: s.headerRow,
          row_count: s.rows.length,
          sample: s.rows.slice(0, 5),
          suggested_mapping: saved ?? suggestMapping(s.headers),
          mapping_source: saved ? 'saved' : 'guessed',
        };
      }),
    };
  });


  app.get('/api/imports', async () =>
    db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM import_row r WHERE r.batch_id = b.id) rows_total,
                (SELECT COUNT(*) FROM import_row r WHERE r.batch_id = b.id AND r.status = 'accepted') rows_accepted,
                (SELECT COUNT(*) FROM import_row r WHERE r.batch_id = b.id AND r.status = 'rejected') rows_rejected,
                (SELECT COUNT(*) FROM import_row r WHERE r.batch_id = b.id AND r.status IN ('already_imported','duplicate_in_file')) rows_repeat
         FROM import_batch b ORDER BY b.imported_at DESC`,
      )
      .all(),
  );

  app.get('/api/imports/:id/problems.csv', async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const rows = db
      .prepare("SELECT row_number, status, errors_json, warnings_json, raw_json FROM import_row WHERE batch_id = ? AND status <> 'accepted' ORDER BY row_number")
      .all(id) as any[];
    const out = rows.map((r) => ({
      row_number: r.row_number,
      status: r.status,
      problems: [...JSON.parse(r.errors_json ?? '[]'), ...JSON.parse(r.warnings_json ?? '[]')].join('; '),
      ...JSON.parse(r.raw_json),
    }));
    return reply.header('content-disposition', `attachment; filename="import-problems-${id}.csv"`).type('text/csv').send(toCsv(out));
  });

  // Every lead a bulk import left out (repeats, missing details, discarded), with the file each came from.
  app.get('/api/bulk-imports/:id/problems.csv', async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const rows = db
      .prepare(
        `SELECT b.name batch, b.file_name file, r.row_number, r.status, r.errors_json, r.warnings_json, r.raw_json
         FROM import_row r JOIN import_batch b ON b.id = r.batch_id
         WHERE r.status <> 'accepted' AND r.batch_id IN (
           SELECT j.value FROM import_bulk_file f, json_each(f.summary_json, '$.batches') j WHERE f.bulk_id = ? AND f.summary_json IS NOT NULL)
         ORDER BY b.imported_at, r.row_number`,
      )
      .all(id) as any[];
    const out = rows.map((r) => ({
      file: r.file,
      batch: r.batch,
      row_number: r.row_number,
      status: r.status,
      problems: [...JSON.parse(r.errors_json ?? '[]'), ...JSON.parse(r.warnings_json ?? '[]')].join('; '),
      ...JSON.parse(r.raw_json),
    }));
    return reply.header('content-disposition', `attachment; filename="bulk-import-not-imported-${id}.csv"`).type('text/csv').send(toCsv(out));
  });

  // ---------- export & backup ----------
  app.get('/api/export/:file', async (req, reply) => {
    const { file } = z.object({ file: z.string().max(60) }).parse(req.params);
    const { health } = z.object({ health: z.enum(['0', '1']).default('0') }).parse(req.query);
    const includeHealth = health === '1';
    const stamp = new Date().toISOString().slice(0, 10);
    if (file === 'dump.json') {
      return reply.header('content-disposition', `attachment; filename="mpcrm-dump-${stamp}.json"`).type('application/json').send(JSON.stringify(fullJsonDump(db)));
    }
    if (file === 'all.xlsx') {
      const buf = await toXlsx(EXPORT_TABLES.map((t) => ({ name: t, rows: exportRows(db, t, { includeHealth }) })));
      return reply.header('content-disposition', `attachment; filename="mpcrm-export-${stamp}.xlsx"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
    }
    const m = file.match(/^([a-z_]+)\.(csv|xlsx)$/);
    if (!m || !(EXPORT_TABLES as readonly string[]).includes(m[1]!)) throw new DomainError('unknown export', 404);
    const rows = exportRows(db, m[1] as ExportTable, { includeHealth });
    if (m[2] === 'csv') {
      return reply.header('content-disposition', `attachment; filename="${m[1]}-${stamp}.csv"`).type('text/csv').send(toCsv(rows));
    }
    const buf = await toXlsx([{ name: m[1]!, rows }]);
    return reply.header('content-disposition', `attachment; filename="${m[1]}-${stamp}.xlsx"`)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  });

  app.get('/api/backups', async () =>
    listBackups(config).reverse().map((f) => {
      const st = fs.statSync(f);
      return { file: path.basename(f), bytes: st.size, created_at: st.mtime.toISOString() };
    }),
  );

  app.post('/api/backups', async () => {
    const r = await createBackup(db, config);
    return { file: path.basename(r.file), bytes: r.bytes, encrypted: r.encrypted, counts: r.counts };
  });

  // ---------- static UI ----------
  if (deps.webDir && fs.existsSync(deps.webDir)) {
    await app.register(fastifyStatic, { root: deps.webDir, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

export { batchPdf };
