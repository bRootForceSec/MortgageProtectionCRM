import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { findClaudeCode, claudeNotFoundMessage } from '../ai/findClaude.js';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import { addBatchToCallList } from '../domain/callList.js';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import type { ParsedFile } from '../domain/spreadsheet.js';
import type { ColumnMapping } from '../domain/mapping.js';
import { DomainError } from '../core/errors.js';
import {
  createPdfDraft, createSheetDraft, DraftWorker, getDraftView, listDrafts, reviewRow, setRowsType, updateDraftSettings,
  deleteDraft, draftFile, commitDraft, lastLeadType,
} from '../domain/drafts.js';
import { loadAiSettings, saveAiSettings, type Secrets } from '../ai/settings.js';
import { editLead, EDITABLE_FIELDS } from '../domain/leadEdit.js';
import { listLeadTypes, saveLeadType } from '../domain/leadTypes.js';
import { listCounties, setCountyAreaCodes } from '../domain/areaCodes.js';
import type { BulkImporter } from '../domain/bulkImport.js';

// Routes for PDF and spreadsheet imports with review, AI settings, lead types and prices, and county groups.

export const MAX_PDF_BYTES = 200 * 1024 * 1024;

const batchSchema = z.object({
  name: z.string().min(1).max(200),
  purchased_count: z.number().int().min(0).max(1_000_000).nullish(),
  cost_total_cents: z.number().int().min(0).max(1e10).nullish(),
  cost_per_lead_cents: z.number().int().min(0).max(1e8).nullish(),
  lead_type: z.string().max(100).nullish(),
  lead_age_label: z.string().max(100).nullish(),
  notes: z.string().max(2000).nullish(),
});

const fieldsSchema = z.record(z.string().max(40), z.string().max(500));
const typeCode = z.string().min(1).max(20).regex(/^[A-Za-z0-9-]+$/);

/** Reads a URI-encoded upload header. A badly encoded value counts as missing, so the upload still goes through. */
export function uploadHeader(headers: Record<string, unknown>, name: string, fallback: string): string {
  try {
    return decodeURIComponent(String(headers[name] ?? fallback));
  } catch {
    return fallback;
  }
}

function fileModifiedHeader(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function registerImportRoutes(
  app: FastifyInstance,
  deps: {
    db: DB;
    config: Config;
    worker: DraftWorker;
    bulk: BulkImporter;
    secrets: Secrets;
    getUpload: (id: string) => { parsed: ParsedFile; buf: Buffer };
    dropUpload: (id: string) => void;
  },
) {
  const { db, config, worker, secrets, bulk } = deps;

  app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: MAX_PDF_BYTES }, (_req, body, done) => done(null, body));

  // ---------- drafts ----------
  app.get('/api/drafts', async () => listDrafts(db));

  app.post('/api/drafts/pdf', async (req) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) throw new DomainError('empty file');
    const name = uploadHeader(req.headers, 'x-file-name', 'leads.pdf').replace(/[/\\]/g, '_').slice(0, 200);
    const q = z.object({ lead_type: typeCode.optional() }).parse(req.query);
    const { id } = createPdfDraft(db, config.importsDir, { fileName: name, bytes: buf, fileModified: fileModifiedHeader(req.headers['x-file-modified']) }, q.lead_type ? { default_lead_type: q.lead_type } : {});
    void worker.run(id);
    return { id };
  });

  app.post('/api/drafts/sheet', async (req) => {
    const b = z
      .object({
        upload_id: z.string().max(64),
        sheet: z.string().max(200),
        mapping: z.record(z.string(), z.string().max(300)),
        lead_type: typeCode.nullish(),
        file_modified: z.number().nullish(),
      })
      .parse(req.body);
    const u = deps.getUpload(b.upload_id);
    const s = u.parsed.sheets.find((x) => x.name === b.sheet);
    if (!s) throw new DomainError('sheet not found');
    const { id } = createSheetDraft(
      db, config.importsDir,
      { fileName: u.parsed.fileName, sha256: u.parsed.sha256, bytes: u.buf, fileModified: fileModifiedHeader(b.file_modified) },
      s, b.mapping as ColumnMapping, b.lead_type !== undefined ? { default_lead_type: b.lead_type } : {},
    );
    deps.dropUpload(b.upload_id);
    return { id };
  });

  const idParam = z.object({ id: z.string().max(64) });

  app.get('/api/drafts/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return { ...getDraftView(db, id), reading_now: worker.isRunning(id) };
  });

  app.get('/api/drafts/:id/file', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const f = draftFile(db, id);
    if (!fs.existsSync(f.path)) throw new DomainError('the file for this draft is gone', 404);
    return reply.type(f.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream').header('cache-control', 'no-store').send(fs.createReadStream(f.path));
  });

  app.post('/api/drafts/:id/rows/:row', async (req) => {
    const { id, row } = z.object({ id: z.string().max(64), row: z.coerce.number().int().min(0) }).parse(req.params);
    const b = z
      .object({ action: z.enum(['ok', 'discard', 'reopen', 'save']), edits: fieldsSchema.optional(), lead_type: typeCode.nullish() })
      .parse(req.body);
    return reviewRow(db, id, row, { action: b.action, edits: b.edits, lead_type: b.lead_type === undefined ? undefined : b.lead_type });
  });

  app.post('/api/drafts/:id/type', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({
        lead_type: typeCode.nullable(),
        rows: z.array(z.number().int()).max(10_000).optional(),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
        county_key: z.string().max(100).optional(),
        all: z.boolean().optional(),
      })
      .parse(req.body);
    return setRowsType(db, id, b, b.lead_type);
  });

  app.post('/api/drafts/:id/settings', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ default_lead_type: typeCode.nullish(), batch: batchSchema.partial().optional(), import_repeats_as_new: z.boolean().optional() }).parse(req.body);
    return updateDraftSettings(db, id, b);
  });

  app.post('/api/drafts/:id/retry', async (req) => {
    const { id } = idParam.parse(req.params);
    return worker.retryFailed(id);
  });

  app.post('/api/drafts/:id/commit', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ batch: batchSchema, add_to_call_list: z.boolean().optional() }).parse(req.body);
    const r = commitDraft(db, config.importsDir, id, b.batch);
    const call_list = b.add_to_call_list ? addBatchToCallList(db, r.batchId) : null;
    return { batch_id: r.batchId, summary: r.summary, history: r.history, call_list };
  });

  app.delete('/api/drafts/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    deleteDraft(db, id);
    return { ok: true };
  });

  // ---------- bulk import: many files or a whole folder, sent one file at a time ----------
  app.get('/api/bulk-imports', async () => bulk.list());

  app.post('/api/bulk-imports', async (req) => {
    const b = z.object({ lead_type: typeCode.nullish(), add_to_call_list: z.boolean().optional(), import_ready_now: z.boolean().optional() }).parse(req.body);
    return bulk.create({ lead_type: b.lead_type ?? null, add_to_call_list: b.add_to_call_list, import_ready_now: b.import_ready_now });
  });

  app.get('/api/bulk-imports/:id', async (req) => bulk.status(idParam.parse(req.params).id));

  // PDFs up to the PDF limit; spreadsheets are checked against their own, smaller limit.
  app.post('/api/bulk-imports/:id/files', { bodyLimit: MAX_PDF_BYTES }, async (req) => {
    const { id } = idParam.parse(req.params);
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf)) throw new DomainError('send the file as the request body');
    const name = uploadHeader(req.headers, 'x-file-name', 'leads').replace(/[/\\]/g, '_').slice(0, 200);
    const relPath = uploadHeader(req.headers, 'x-file-path', '').slice(0, 1000) || null;
    return bulk.addFile(id, { fileName: name, relPath, bytes: buf, fileModified: fileModifiedHeader(req.headers['x-file-modified']) });
  });

  // ---------- AI settings (keys are write-only) ----------
  const aiView = () => ({ ...loadAiSettings(db), keys: secrets.present() });
  app.get('/api/settings/ai', async () => aiView());
  app.put('/api/settings/ai', async (req) => {
    saveAiSettings(db, req.body);
    return aiView();
  });
  app.put('/api/settings/ai/key', async (req) => {
    const b = z.object({ name: z.enum(['anthropic_api_key', 'openai_api_key']), value: z.string().max(500).nullable() }).parse(req.body);
    secrets.set(b.name, b.value);
    return aiView();
  });
  app.post('/api/settings/ai/test', async () => {
    const s = loadAiSettings(db);
    if (s.provider === 'claude_code') {
      const found = findClaudeCode(s.claude_code.command);
      if (!found) return { ok: false, message: claudeNotFoundMessage(s.claude_code.command) };
      try {
        const { stdout } = await promisify(execFile)(found.file, [...found.prefix, '--version'], { timeout: 20_000, windowsHide: true });
        return { ok: true, message: `Found Claude Code ${stdout.trim()}. Pages are read with your Claude account.` };
      } catch (e: any) {
        return { ok: false, message: e.code === 'ENOENT' ? claudeNotFoundMessage(s.claude_code.command) : e.message };
      }
    }
    if (s.provider === 'anthropic_api') return { ok: secrets.present().anthropic_api_key, message: secrets.present().anthropic_api_key ? 'API key saved.' : 'No API key saved yet.' };
    if (s.provider === 'openai_compatible') {
      try {
        const r = await fetch(`${s.openai_compatible.base_url.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(10_000) });
        return { ok: r.ok, message: r.ok ? `Reached ${s.openai_compatible.base_url}.` : `${s.openai_compatible.base_url} answered ${r.status}.` };
      } catch (e: any) {
        return { ok: false, message: `Couldn't reach ${s.openai_compatible.base_url}: ${e.message}` };
      }
    }
    return { ok: false, message: 'AI reading is off. Scanned pages will be typed in by hand.' };
  });

  // ---------- lead types and prices ----------
  app.get('/api/import-defaults', async () => ({ lead_type: lastLeadType(db) }));
  app.get('/api/lead-types', async () => listLeadTypes(db));
  app.put('/api/lead-types/:code', async (req) => {
    const { code } = z.object({ code: typeCode }).parse(req.params);
    const b = z
      .object({
        label: z.string().min(1).max(200).optional(),
        price_cents: z.number().int().min(0).max(1e8).nullable().optional(),
        active: z.boolean().optional(),
        sort_order: z.number().int().optional(),
      })
      .parse(req.body);
    return saveLeadType(db, code, b);
  });

  // ---------- counties and their area codes ----------
  app.get('/api/counties', async () => listCounties(db));

  app.put('/api/counties/area-codes', async (req) => {
    const b = z.object({ county_key: z.string().min(3).max(100), area_codes: z.array(z.string().regex(/^\d{3}$/)).max(20) }).parse(req.body);
    setCountyAreaCodes(db, b.county_key, b.area_codes);
    return { ok: true };
  });

  // ---------- change a lead's type or county later (the old value is kept) ----------
  app.patch('/api/leads/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({
      lead_type: typeCode.nullable().optional(),
      county: z.string().max(100).nullable().optional(),
      details: z.partialRecord(z.enum(EDITABLE_FIELDS), z.string().max(500).nullable()).optional(),
    }).parse(req.body);
    return editLead(db, id, b);
  });
}
