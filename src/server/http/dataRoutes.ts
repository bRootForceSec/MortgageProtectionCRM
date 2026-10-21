import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import { DomainError } from '../core/errors.js';
import { exportRows, toCsv, toXlsx, fullJsonDump, EXPORT_TABLES, type ExportTable } from '../domain/exporter.js';
import { createBackup, listBackups, lastBackupCheck, runBackupCheck } from '../backup.js';

// Your data: exports and backups.

export function registerDataRoutes(app: FastifyInstance, deps: { db: DB; config: Config }) {
  const { db, config } = deps;

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

  // ---------- backup restore check ----------
  app.get('/api/backups/check', async () => lastBackupCheck(db));
  app.post('/api/backups/check', async () => runBackupCheck(db, config));
}
