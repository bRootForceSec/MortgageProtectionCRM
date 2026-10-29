import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import { registerSecurity } from './security.js';
import { MAX_UPLOAD_BYTES } from '../domain/spreadsheet.js';
import { LEAD_FIELDS } from '../domain/mapping.js';
import { MappingError } from '../domain/importer.js';
import { activeOutcomeCodes } from '../domain/calls.js';
import { activeObjectionCodes } from '../domain/objections.js';
import { DomainError } from '../core/errors.js';
import { listNumbers } from '../domain/numbers.js';
import { Updates } from '../updates.js';
import { DraftWorker } from '../domain/drafts.js';
import { BulkImporter } from '../domain/bulkImport.js';
import { batchPdf } from '../domain/pageTurn.js';
import { PageChecker } from '../domain/pageTurnFix.js';
import { makeReader } from '../ai/readers.js';
import { loadAiSettings, Secrets } from '../ai/settings.js';
import { registerImportRoutes } from './importRoutes.js';
import { registerLeadRoutes } from './leadRoutes.js';
import { registerCallingRoutes } from './callingRoutes.js';
import { registerNumberRoutes } from './numberRoutes.js';
import { registerReportRoutes } from './reportRoutes.js';
import { registerDataRoutes } from './dataRoutes.js';
import { registerUnitrustRoutes } from './unitrustRoutes.js';
import { KdeConnect } from '../dialer.js';

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

  const secrets = deps.secrets ?? Secrets.inDataDir(config.dataDir);
  registerSecurity(app, { token: deps.token, port: config.port, extensionKey: () => secrets.get('unitrust_extension_key') });

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

  const drafts = deps.drafts ?? new DraftWorker(db, secrets);
  const bulk = deps.bulk ?? new BulkImporter(db, config.importsDir, drafts);
  const pageChecker = deps.pageChecker ?? new PageChecker(db, config.importsDir, () => makeReader(loadAiSettings(db), secrets));
  registerImportRoutes(app, { db, config, worker: drafts, bulk, secrets });
  registerLeadRoutes(app, { db, config, pageChecker });
  registerCallingRoutes(app, { db, kde: deps.kde });
  registerNumberRoutes(app, { db });
  registerReportRoutes(app, { db });
  registerDataRoutes(app, { db, config });
  registerUnitrustRoutes(app, { db, secrets });

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
    objection_codes: activeObjectionCodes(db),
    lead_fields: LEAD_FIELDS.map(({ key, label }) => ({ key, label })),
    numbers: listNumbers(db),
    data_dir: config.dataDir,
    version: updates.build,
  }));

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
