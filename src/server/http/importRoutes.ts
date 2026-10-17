import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import type { ParsedFile } from '../domain/spreadsheet.js';
import type { ColumnMapping } from '../domain/mapping.js';
import { DomainError } from '../domain/calls.js';
import {
  createPdfDraft, createSheetDraft, DraftWorker, getDraftView, listDrafts, reviewRow, setRowsType, updateDraftSettings,
  deleteDraft, draftFile, commitDraft,
} from '../domain/drafts.js';
import { loadAiSettings, saveAiSettings, getSetting, type Secrets } from '../ai/settings.js';
import { countyKey, countyDisplayName } from '../domain/county.js';
import { rebuildLeadState } from '../domain/leadState.js';
import { uuidv7, nowIso } from '../ids.js';
import { editLeadDetails, EDITABLE_FIELDS } from '../domain/leadEdit.js';

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
    secrets: Secrets;
    getUpload: (id: string) => { parsed: ParsedFile; buf: Buffer };
    dropUpload: (id: string) => void;
  },
) {
  const { db, config, worker, secrets } = deps;

  app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: MAX_PDF_BYTES }, (_req, body, done) => done(null, body));

  // ---------- drafts ----------
  app.get('/api/drafts', async () => listDrafts(db));

  app.post('/api/drafts/pdf', async (req) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) throw new DomainError('empty file');
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'leads.pdf')).replace(/[/\\]/g, '_').slice(0, 200);
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
    const b = z.object({ batch: batchSchema }).parse(req.body);
    const r = commitDraft(db, config.importsDir, id, b.batch);
    return { batch_id: r.batchId, summary: r.summary, history: r.history };
  });

  app.delete('/api/drafts/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    deleteDraft(db, id);
    return { ok: true };
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
      try {
        const { stdout } = await promisify(execFile)(s.claude_code.command, ['--version'], { timeout: 20_000 });
        return { ok: true, message: `Found Claude Code ${stdout.trim()}. Pages are read with your Claude account.` };
      } catch (e: any) {
        return { ok: false, message: e.code === 'ENOENT' ? `Couldn't find "${s.claude_code.command}". Install Claude Code, or enter its full path.` : e.message };
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
  app.get('/api/import-defaults', async () => ({ lead_type: getSetting<string>(db, 'import.last_lead_type') ?? 'D' }));
  app.get('/api/lead-types', async () => db.prepare('SELECT * FROM lead_type ORDER BY sort_order, code').all());
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
    const now = nowIso();
    return db.transaction(() => {
      const old = db.prepare('SELECT * FROM lead_type WHERE code = ?').get(code) as any;
      if (!old) {
        if (!b.label) throw new DomainError('a new lead type needs a name');
        const max = (db.prepare('SELECT max(sort_order) m FROM lead_type').get() as { m: number | null }).m ?? 0;
        db.prepare('INSERT INTO lead_type (code, label, price_cents, sort_order, active, updated_at) VALUES (?,?,?,?,?,?)').run(
          code, b.label, b.price_cents ?? null, b.sort_order ?? max + 10, b.active === false ? 0 : 1, now,
        );
      } else {
        db.prepare(
          'UPDATE lead_type SET label = ?, price_cents = ?, active = ?, sort_order = ?, updated_at = ? WHERE code = ?',
        ).run(
          b.label ?? old.label, b.price_cents !== undefined ? b.price_cents : old.price_cents,
          b.active === undefined ? old.active : b.active ? 1 : 0, b.sort_order ?? old.sort_order, now, code,
        );
      }
      const neu = db.prepare('SELECT * FROM lead_type WHERE code = ?').get(code);
      db.prepare('INSERT INTO audit_log (id, at, table_name, row_id, action, old_json, new_json) VALUES (?,?,?,?,?,?,?)').run(
        uuidv7(), now, 'lead_type', code, old ? 'update' : 'insert', old ? JSON.stringify(old) : null, JSON.stringify(neu),
      );
      return neu;
    })();
  });

  // ---------- counties and their area codes ----------
  app.get('/api/counties', async () => {
    const rows = db
      .prepare(
        `SELECT l.county_key, max(l.county) county, max(l.state) state, COUNT(*) leads,
                SUM(CASE WHEN s.status NOT IN ('dead','invalid','sold') THEN 1 ELSE 0 END) workable
         FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE l.county_key IS NOT NULL GROUP BY l.county_key ORDER BY state, county`,
      )
      .all() as { county_key: string; county: string; state: string; leads: number; workable: number }[];
    const codes = db.prepare('SELECT county_key, area_code FROM county_area_code ORDER BY area_code').all() as { county_key: string; area_code: string }[];
    // Suggestion only: the area code most of this county's leads have. You confirm it.
    const common = db.prepare(
      `SELECT substr(phone_e164, 3, 3) code, COUNT(*) n FROM lead WHERE county_key = ? AND phone_e164 LIKE '+1%'
       GROUP BY code ORDER BY n DESC LIMIT 3`,
    );
    const known = new Set(rows.map((r) => r.county_key));
    const extra = [...new Set(codes.map((c) => c.county_key))].filter((k) => !known.has(k));
    return [
      ...rows.map((r) => ({
        ...r,
        name: countyDisplayName(r.county_key),
        area_codes: codes.filter((c) => c.county_key === r.county_key).map((c) => c.area_code),
        // Only codes shared by a good part of the county's leads; a few out-of-area numbers aren't a hint.
        suggested: (common.all(r.county_key) as { code: string; n: number }[])
          .filter((c) => c.n >= 3 && c.n / r.leads >= 0.25)
          .map((c) => ({ area_code: c.code, leads: c.n })),
      })),
      ...extra.map((k) => ({
        county_key: k, county: countyDisplayName(k), name: countyDisplayName(k), state: k.split('|')[0], leads: 0, workable: 0,
        area_codes: codes.filter((c) => c.county_key === k).map((c) => c.area_code), suggested: [],
      })),
    ];
  });

  app.put('/api/counties/area-codes', async (req) => {
    const b = z.object({ county_key: z.string().min(3).max(100), area_codes: z.array(z.string().regex(/^\d{3}$/)).max(20) }).parse(req.body);
    const now = nowIso();
    db.transaction(() => {
      const old = (db.prepare('SELECT area_code FROM county_area_code WHERE county_key = ?').all(b.county_key) as { area_code: string }[]).map((r) => r.area_code);
      db.prepare('DELETE FROM county_area_code WHERE county_key = ?').run(b.county_key);
      const ins = db.prepare('INSERT OR IGNORE INTO county_area_code (county_key, area_code, created_at) VALUES (?,?,?)');
      for (const c of b.area_codes) ins.run(b.county_key, c, now);
      db.prepare('INSERT INTO audit_log (id, at, table_name, row_id, action, old_json, new_json) VALUES (?,?,?,?,?,?,?)').run(
        uuidv7(), now, 'county_area_code', b.county_key, 'set', JSON.stringify(old), JSON.stringify(b.area_codes),
      );
    })();
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
    const now = nowIso();
    return db.transaction(() => {
      const lead = db.prepare('SELECT * FROM lead WHERE id = ?').get(id) as any;
      if (!lead) throw new DomainError('lead not found', 404);
      const change = db.prepare('INSERT INTO lead_change (id, lead_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?)');
      if (b.details) {
        editLeadDetails(db, id, b.details);
        // A new state matters for the county below.
        lead.state = (db.prepare('SELECT state FROM lead WHERE id = ?').get(id) as { state: string | null }).state;
      }
      if (b.lead_type !== undefined && b.lead_type !== lead.lead_type) {
        const t = b.lead_type ? (db.prepare('SELECT price_cents FROM lead_type WHERE code = ?').get(b.lead_type) as { price_cents: number | null } | undefined) : null;
        if (b.lead_type && !t) throw new DomainError(`unknown lead type "${b.lead_type}"`);
        change.run(uuidv7(), id, 'lead_type', lead.lead_type, b.lead_type, now);
        // The price follows the type, so cost per appointment stays right.
        change.run(uuidv7(), id, 'price_cents', lead.price_cents == null ? null : String(lead.price_cents), t?.price_cents == null ? null : String(t.price_cents), now);
        db.prepare('UPDATE lead SET lead_type = ?, price_cents = ? WHERE id = ?').run(b.lead_type, t?.price_cents ?? null, id);
      }
      if (b.county !== undefined) {
        if (b.county && !lead.state) throw new DomainError('this lead has no state, so the county can\'t be set');
        const key = b.county ? countyKey(lead.state, b.county) : null;
        if (key !== lead.county_key) {
          change.run(uuidv7(), id, 'county', lead.county_key, key, now);
          db.prepare("UPDATE lead SET county = ?, county_key = ?, county_source = 'manual' WHERE id = ?").run(
            key ? countyDisplayName(key) : null, key, id,
          );
        }
      }
      rebuildLeadState(db, [id]);
      return db.prepare('SELECT * FROM lead WHERE id = ?').get(id);
    })();
  });
}
