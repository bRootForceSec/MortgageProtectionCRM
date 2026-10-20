import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { DomainError } from './calls.js';
import { type FieldValues, type SourceRow, type BatchInput, mapFields, previewRows, commitRows, saveMapping, sheetSourceRows } from './importer.js';
import type { LeadFieldKey, ColumnMapping } from './mapping.js';
import type { ParsedSheet } from './spreadsheet.js';
import { isKnownCounty } from './county.js';
import { titleCaseIfShouting } from './normalize.js';
import { readPdfText, extractPage, type ReadIssue } from './pdfReader.js';
import { turnPdfPages, normTurn } from './pageTurn.js';
import { PROMPT_VERSION, type PageAnswer } from '../ai/prompt.js';
import { makeReader, AiError, type PageReader } from '../ai/readers.js';
import { loadAiSettings, getSetting, setSetting, type Secrets } from '../ai/settings.js';

// An import in progress. A PDF is read page by page (typed pages from their text, scans by the AI reader),
// then you review what needs a look, set lead types, and commit. Everything is saved as it goes,
// so you can stop and come back; only "Delete draft" throws the work away.

export interface DraftRowData {
  fields: FieldValues;
  extra: Record<string, string>;
  /** Values as read, by the label on the page (or the sheet's own columns). */
  raw: Record<string, string>;
  uncertain: { field: string; best_reading: string | null; reason: string }[];
  reader_issues: ReadIssue[];
  /** Degrees the page still has to be turned clockwise in the draft's PDF to read upright (done when reading ends). */
  turn?: number;
}

export type Review = 'auto' | 'needs_review' | 'ok' | 'discarded';

interface DraftRowDb {
  draft_id: string;
  row_number: number;
  page: number | null;
  fields_json: string;
  edits_json: string | null;
  issues_json: string | null;
  notes: string | null;
  extractor: string | null;
  review: Review;
  lead_type: string | null;
}

export interface DraftSettings {
  sheet?: string;
  mapping?: ColumnMapping;
  default_lead_type?: string | null;
  batch?: Partial<BatchInput>;
  /** Import leads identical to ones imported before as new leads (you bought the same lead again). */
  import_repeats_as_new?: boolean;
}

export interface Progress {
  phase: 'text' | 'ai' | 'done';
  total: number;
  text_done: number;
  ai_total: number;
  ai_done: number;
  ai_failed: number;
  cost_usd: number;
  reader: string | null;
  error?: string | null;
}

/** Fields the AI reports by its own names. */
const AI_FIELD: Record<keyof PageAnswer['fields'], LeadFieldKey> = {
  full_name: 'full_name', coborrower: 'coborrower', age: 'age', dob: 'dob', lender: 'lender', loan_amount: 'loan_amount',
  address: 'address', city: 'city', state: 'state', zip: 'zip', county: 'county', source_lead_id: 'source_lead_id',
  callin_date: 'callin_date', phone: 'phone', alt_phone: 'phone2', called_from: 'phone3',
};

// ---------------------------------------------------------------------------------------------
// Assessment: what still needs a look on a row.

export function effectiveFields(data: DraftRowData, edits: FieldValues | null): { fields: FieldValues; notes: string[] } {
  const f: FieldValues = { ...data.fields };
  for (const [k, v] of Object.entries(edits ?? {}) as [LeadFieldKey, string][]) {
    if (v === '' || v == null) delete f[k];
    else f[k] = v;
  }
  const notes: string[] = [];
  // The contact phone is the number to call; "Called in From" stands in only when it is missing.
  if (!f.phone && f.phone3) {
    f.phone = f.phone3;
    notes.push('No contact phone on the page, so the "Called in From" number is used.');
  }
  return { fields: f, notes };
}

export function assessRow(data: DraftRowData, edits: FieldValues | null): ReadIssue[] {
  const { fields } = effectiveFields(data, edits);
  const { lead, errors, warnings } = mapFields(fields, data.extra);
  const edited = new Set(Object.keys(edits ?? {}));
  const issues: ReadIssue[] = [];
  const has = (field: string) => issues.some((i) => i.field === field && i.blocking);
  for (const r of data.reader_issues) if (!edited.has(r.field)) issues.push(r);
  for (const e of errors) issues.push({ field: e.includes('name') ? 'full_name' : 'phone', message: e, blocking: true, kind: 'missing' });
  if (!lead.address_line) issues.push({ field: 'address', message: 'no street address', blocking: true, kind: 'missing' });
  if (!lead.county_key) {
    issues.push({ field: 'county', message: 'Which county was this lead bought for? It isn\'t on the page and the address didn\'t settle it.', blocking: true, kind: 'missing' });
  } else if (lead.county_source === 'page' && !isKnownCounty(lead.county_key)) {
    issues.push({ field: 'county', message: `"${lead.county}" isn't a county in ${lead.state}. Check the spelling.`, blocking: true, kind: 'missing' });
  }
  for (const u of data.uncertain) {
    const field = (AI_FIELD as Record<string, string>)[u.field] ?? u.field;
    if (edited.has(field)) continue;
    const why = `${u.reason}${u.best_reading ? ` (best reading: ${u.best_reading})` : ''}`;
    const existing = issues.find((i) => i.field === field && i.blocking);
    if (existing) {
      existing.message += `. The AI wasn't sure: ${why}`;
      continue;
    }
    issues.push({
      field,
      kind: 'uncertain',
      message: `Not sure of this: ${why}`,
      blocking: ['full_name', 'phone', 'address', 'city', 'state', 'zip', 'county'].includes(field),
    });
  }
  for (const w of warnings) issues.push({ field: '', message: w, blocking: false, kind: 'note' });
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Storage helpers

function getDraft(db: DB, id: string) {
  const d = db.prepare('SELECT * FROM import_draft WHERE id = ?').get(id) as any;
  if (!d || d.status === 'deleted') throw new DomainError('import draft not found', 404);
  return d as {
    id: string; kind: 'pdf' | 'sheet'; file_name: string; file_sha256: string; file_path: string; file_modified: string | null;
    status: 'reading' | 'review' | 'committed' | 'deleted'; settings_json: string; progress_json: string | null; created_at: string;
    updated_at: string; batch_id: string | null;
  };
}

function rowsOf(db: DB, id: string) {
  return db.prepare('SELECT * FROM import_draft_row WHERE draft_id = ? ORDER BY row_number').all(id) as DraftRowDb[];
}

const upsertRow = (db: DB) =>
  db.prepare(
    `INSERT INTO import_draft_row (draft_id, row_number, page, fields_json, edits_json, issues_json, notes, extractor, review, lead_type, updated_at)
     VALUES (@draft_id, @row_number, @page, @fields_json, @edits_json, @issues_json, @notes, @extractor, @review, @lead_type, @updated_at)
     ON CONFLICT(draft_id, row_number) DO UPDATE SET fields_json = excluded.fields_json, edits_json = excluded.edits_json,
       issues_json = excluded.issues_json, notes = excluded.notes, extractor = excluded.extractor, review = excluded.review,
       lead_type = excluded.lead_type, updated_at = excluded.updated_at`,
  );

function reviewFor(current: Review, issues: ReadIssue[]): Review {
  if (current === 'ok' || current === 'discarded') return current;
  return issues.some((i) => i.blocking) ? 'needs_review' : 'auto';
}

function setProgress(db: DB, id: string, p: Progress, status?: 'reading' | 'review') {
  db.prepare('UPDATE import_draft SET progress_json = ?, status = coalesce(?, status), updated_at = ? WHERE id = ?').run(
    JSON.stringify(p), status ?? null, nowIso(), id,
  );
}

const emptyData = (): DraftRowData => ({ fields: {}, extra: {}, raw: {}, uncertain: [], reader_issues: [] });

// ---------------------------------------------------------------------------------------------
// Creating drafts

export function draftsDir(importsDir: string) {
  const d = path.join(importsDir, 'drafts');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function createPdfDraft(
  db: DB,
  importsDir: string,
  file: { fileName: string; bytes: Buffer; fileModified?: string | null },
  settings: DraftSettings = {},
) {
  if (file.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new DomainError('this file is not a PDF');
  const id = uuidv7();
  const filePath = path.join(draftsDir(importsDir), `${id}.pdf`);
  fs.writeFileSync(filePath, file.bytes, { mode: 0o600 });
  const now = nowIso();
  const defaults = { default_lead_type: settings.default_lead_type ?? lastLeadType(db), ...settings };
  db.prepare(
    `INSERT INTO import_draft (id, kind, file_name, file_sha256, file_path, file_modified, status, settings_json, progress_json, created_at, updated_at)
     VALUES (?, 'pdf', ?, ?, ?, ?, 'reading', ?, ?, ?, ?)`,
  ).run(
    id, file.fileName, createHash('sha256').update(file.bytes).digest('hex'), filePath, file.fileModified ?? null,
    JSON.stringify(defaults), JSON.stringify({ phase: 'text', total: 0, text_done: 0, ai_total: 0, ai_done: 0, ai_failed: 0, cost_usd: 0, reader: null }),
    now, now,
  );
  return { id };
}

/** Blanked-out rows (only a status left) were removed from the call list on purpose: they are discarded. */
function blankedOut(f: FieldValues) {
  return !f.full_name && !f.first_name && !f.last_name && !f.phone && !f.address;
}

export function createSheetDraft(
  db: DB,
  importsDir: string,
  file: { fileName: string; sha256: string; bytes: Buffer; fileModified?: string | null },
  sheet: ParsedSheet,
  mapping: ColumnMapping,
  settings: DraftSettings = {},
) {
  const source = sheetSourceRows(sheet, mapping);
  const id = uuidv7();
  const ext = path.extname(file.fileName).toLowerCase().replace(/[^.a-z]/g, '') || '.xlsx';
  const filePath = path.join(draftsDir(importsDir), `${id}${ext}`);
  fs.writeFileSync(filePath, file.bytes, { mode: 0o600 });
  const now = nowIso();
  const all = { default_lead_type: settings.default_lead_type ?? lastLeadType(db), ...settings, sheet: sheet.name, mapping };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO import_draft (id, kind, file_name, file_sha256, file_path, file_modified, status, settings_json, progress_json, created_at, updated_at)
       VALUES (?, 'sheet', ?, ?, ?, ?, 'review', ?, ?, ?, ?)`,
    ).run(
      id, file.fileName, file.sha256, filePath, file.fileModified ?? null, JSON.stringify(all),
      JSON.stringify({ phase: 'done', total: source.length, text_done: source.length, ai_total: 0, ai_done: 0, ai_failed: 0, cost_usd: 0, reader: null }),
      now, now,
    );
    const up = upsertRow(db);
    for (const s of source) {
      const data: DraftRowData = { fields: s.fields, extra: s.extra ?? {}, raw: s.raw, uncertain: [], reader_issues: [] };
      const discarded = blankedOut(s.fields) && Object.values(s.raw).some((v) => String(v ?? '').trim());
      const issues = assessRow(data, null);
      up.run({
        draft_id: id, row_number: s.rowNumber, page: null, fields_json: JSON.stringify(data), edits_json: null,
        issues_json: JSON.stringify(issues),
        notes: discarded ? 'Only a status was left on this row (taken off your call list), so it was discarded.' : null,
        extractor: 'sheet', review: discarded ? 'discarded' : reviewFor('auto', issues), lead_type: null, updated_at: now,
      });
    }
  })();
  saveMapping(db, sheet.headers, mapping);
  return { id };
}

function lastLeadType(db: DB): string | null {
  return getSetting<string>(db, 'import.last_lead_type') ?? 'D';
}

// ---------------------------------------------------------------------------------------------
// Reading PDF drafts in the background

export class DraftWorker {
  private running = new Set<string>();
  /** For tests: replace the AI reader. */
  readerOverride: PageReader | null | undefined = undefined;
  concurrency = 2;

  constructor(private db: DB, private secrets: Secrets) {}

  /** Picks up drafts that were still being read when the app last stopped. */
  resumeAll() {
    // Files from a bulk import are read a few at a time by the bulk importer instead.
    const ids = this.db
      .prepare("SELECT id FROM import_draft WHERE status = 'reading' AND id NOT IN (SELECT draft_id FROM import_bulk_file WHERE draft_id IS NOT NULL)")
      .all() as { id: string }[];
    for (const { id } of ids) void this.run(id);
  }

  /** Starts (or continues) reading a draft. Resolves when the reading is finished. */
  run(id: string): Promise<void> {
    if (this.running.has(id)) return Promise.resolve();
    this.running.add(id);
    return this.read(id)
      .catch((e) => {
        const d = this.db.prepare('SELECT progress_json FROM import_draft WHERE id = ?').get(id) as { progress_json: string } | undefined;
        if (!d) return;
        const p = { ...(JSON.parse(d.progress_json ?? '{}') as Progress), error: (e as Error).message };
        setProgress(this.db, id, p, 'review');
      })
      .finally(() => this.running.delete(id));
  }

  isRunning(id: string) {
    return this.running.has(id);
  }

  private alive(id: string) {
    const d = this.db.prepare('SELECT status FROM import_draft WHERE id = ?').get(id) as { status: string } | undefined;
    return d?.status === 'reading';
  }

  private async read(id: string) {
    const db = this.db;
    const draft = getDraft(db, id);
    const bytes = new Uint8Array(fs.readFileSync(draft.file_path));
    const progress: Progress = JSON.parse(draft.progress_json ?? '{}');
    const up = upsertRow(db);
    const now = () => nowIso();

    // 1. Typed pages, from their text. Fast; done again only if it never finished.
    if (progress.phase === 'text') {
      const pages = await readPdfText(bytes, (n, total) => {
        if (n % 10 === 0 || n === total) setProgress(db, id, { ...progress, total, text_done: n });
      });
      db.transaction(() => {
        for (const p of pages) {
          const data: DraftRowData = { ...emptyData(), fields: p.fields, extra: p.extra, raw: p.raw, reader_issues: p.issues };
          if (p.turn) data.turn = p.turn;
          const pending = p.kind !== 'text';
          const issues = pending ? [] : assessRow(data, null);
          up.run({
            draft_id: id, row_number: p.page, page: p.page, fields_json: JSON.stringify(data), edits_json: null,
            issues_json: JSON.stringify(issues), notes: null, extractor: pending ? 'pending' : 'text',
            review: pending ? 'needs_review' : reviewFor('auto', issues), lead_type: null, updated_at: now(),
          });
        }
      })();
      Object.assign(progress, {
        phase: 'ai', total: pages.length, text_done: pages.length, ai_total: pages.filter((p) => p.kind !== 'text').length,
        ai_done: 0, ai_failed: 0,
      });
      setProgress(db, id, progress);
    }

    // 2. Scans and unfamiliar layouts, with the AI reader chosen in Settings.
    const pending = (db.prepare("SELECT row_number FROM import_draft_row WHERE draft_id = ? AND extractor = 'pending' ORDER BY row_number").all(id) as { row_number: number }[]).map((r) => r.row_number);
    const reader = this.readerOverride !== undefined ? this.readerOverride : makeReader(loadAiSettings(db), this.secrets);
    progress.reader = reader?.name ?? null;
    const failPage = (page: number, message: string) => {
      const data = emptyData();
      data.reader_issues.push({ field: '', message, blocking: true });
      up.run({
        draft_id: id, row_number: page, page, fields_json: JSON.stringify(data), edits_json: null,
        issues_json: JSON.stringify([...assessRow(data, null)]), notes: null, extractor: 'failed', review: 'needs_review',
        lead_type: null, updated_at: now(),
      });
    };
    const queue = [...pending];
    const work = async () => {
      while (queue.length) {
        if (!this.alive(id)) return;
        const page = queue.shift()!;
        if (!reader) {
          failPage(page, 'This page is a scan and no AI reader is set up (Settings). Type the details in from the page.');
          progress.ai_failed++;
        } else {
          try {
            const result = await reader.read(await extractPage(bytes, page));
            if (!this.alive(id)) return;
            const a = result.answer;
            const fields: FieldValues = {};
            for (const [k, v] of Object.entries(a.fields) as [keyof PageAnswer['fields'], string | null][]) {
              if (v && v.trim()) fields[AI_FIELD[k]] = v.trim();
            }
            const data: DraftRowData = {
              fields, extra: {}, raw: Object.fromEntries(Object.entries(a.fields).filter(([, v]) => v)) as Record<string, string>,
              uncertain: a.uncertain, reader_issues: [],
            };
            const turn = normTurn(Number(a.turn ?? 0) || 0);
            if (turn) data.turn = turn;
            if (!a.is_lead) data.reader_issues.push({ field: '', message: "This page doesn't look like a lead. Discard it if so.", blocking: true });
            if (a.layout !== 'call_in_notice' && !fields.callin_date) data.extra['Page type'] = a.layout.replace(/_/g, ' ');
            const issues = assessRow(data, null);
            up.run({
              draft_id: id, row_number: page, page, fields_json: JSON.stringify(data), edits_json: null,
              issues_json: JSON.stringify(issues), notes: a.notes, extractor: result.extractor,
              // Anything the AI read is shown to you once, unless it was a clean typed layout.
              review: a.layout === 'call_in_notice' ? reviewFor('auto', issues) : 'needs_review', lead_type: null, updated_at: now(),
            });
            progress.ai_done++;
            progress.cost_usd += result.cost_usd ?? 0;
          } catch (e) {
            if (!(e instanceof AiError)) throw e;
            failPage(page, `The AI couldn't read this page (${e.message}). Type the details in from the page.`);
            progress.ai_failed++;
          }
        }
        setProgress(db, id, progress);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, work));
    if (!this.alive(id)) return;
    await this.turnUpright(id);
    progress.phase = 'done';
    setProgress(db, id, progress, 'review');
  }

  /** Turns sideways and upside-down pages upright in the draft's PDF, so the review and the lead page show them the right way. */
  private async turnUpright(id: string) {
    const draft = getDraft(this.db, id);
    if (draft.kind !== 'pdf') return;
    const rows = this.db.prepare('SELECT row_number, page, fields_json FROM import_draft_row WHERE draft_id = ? AND page IS NOT NULL').all(id) as {
      row_number: number; page: number; fields_json: string;
    }[];
    const turns = new Map<number, number>();
    const done: { row_number: number; data: DraftRowData }[] = [];
    for (const r of rows) {
      const data = JSON.parse(r.fields_json) as DraftRowData;
      if (data.turn === undefined) continue;
      if (normTurn(data.turn)) turns.set(r.page, data.turn);
      delete data.turn;
      done.push({ row_number: r.row_number, data });
    }
    if (!done.length) return;
    try {
      await turnPdfPages(draft.file_path, turns);
    } catch {
      return; // A PDF that can't be rewritten is shown as it came; the Turn button still works.
    }
    const upd = this.db.prepare('UPDATE import_draft_row SET fields_json = ? WHERE draft_id = ? AND row_number = ?');
    this.db.transaction(() => {
      for (const d of done) upd.run(JSON.stringify(d.data), id, d.row_number);
    })();
  }

  /** Reads the pages the AI couldn't read again (e.g. after fixing Settings). */
  async retryFailed(id: string) {
    const d = getDraft(this.db, id);
    if (d.status === 'committed') throw new DomainError('this import is already finished');
    const n = this.db.prepare("UPDATE import_draft_row SET extractor = 'pending' WHERE draft_id = ? AND extractor = 'failed' AND edits_json IS NULL AND review <> 'discarded'").run(id).changes;
    if (!n) return { pages: 0 };
    const p = JSON.parse(d.progress_json ?? '{}') as Progress;
    setProgress(this.db, id, { ...p, phase: 'ai', ai_failed: Math.max(0, p.ai_failed - n), error: null }, 'reading');
    void this.run(id);
    return { pages: n };
  }
}

// ---------------------------------------------------------------------------------------------
// Review

export function listDrafts(db: DB) {
  return (db.prepare("SELECT * FROM import_draft WHERE status IN ('reading','review') ORDER BY updated_at DESC").all() as any[]).map((d) => {
    const counts = db
      .prepare('SELECT review, COUNT(*) n FROM import_draft_row WHERE draft_id = ? GROUP BY review')
      .all(d.id) as { review: Review; n: number }[];
    return {
      id: d.id, kind: d.kind, file_name: d.file_name, status: d.status, created_at: d.created_at, updated_at: d.updated_at,
      progress: d.progress_json ? JSON.parse(d.progress_json) : null,
      counts: Object.fromEntries(counts.map((c) => [c.review, c.n])),
    };
  });
}

function sourceRowsOf(db: DB, draft: ReturnType<typeof getDraft>, rows: DraftRowDb[]): SourceRow[] {
  const settings = JSON.parse(draft.settings_json) as DraftSettings;
  return rows
    .filter((r) => r.extractor !== 'pending')
    .map((r) => {
      const data = JSON.parse(r.fields_json) as DraftRowData;
      const edits = r.edits_json ? (JSON.parse(r.edits_json) as FieldValues) : null;
      const { fields, notes } = effectiveFields(data, edits);
      if (draft.kind === 'pdf') {
        // Lead pages print in capitals; store them the way your sheets look.
        for (const k of ['full_name', 'address', 'city'] as const) if (fields[k]) fields[k] = titleCaseIfShouting(fields[k], { keepUpper: k !== 'full_name' })!;
        if (fields.lender) fields.lender = titleCaseIfShouting(fields.lender)!;
        if (fields.coborrower && !/^(yes|no|y|n)$/i.test(fields.coborrower)) fields.coborrower = titleCaseIfShouting(fields.coborrower, { keepUpper: false })!;
      }
      const extra = { ...data.extra };
      const allNotes = [r.notes, ...notes].filter(Boolean).join(' ');
      if (allNotes) extra['Import notes'] = allNotes;
      // Enough to rebuild a standard spreadsheet later: what was read, how, and what you changed.
      const raw: Record<string, string> = { ...data.raw };
      if (draft.kind === 'pdf') {
        raw.__extractor = r.extractor ?? '';
        if (r.extractor?.startsWith('ai:')) raw.__prompt_version = PROMPT_VERSION;
        if (r.notes) raw.__ai_notes = r.notes;
        if (edits && Object.keys(edits).length) raw.__edited = JSON.stringify(edits);
      }
      return {
        rowNumber: r.row_number,
        raw,
        fields,
        extra,
        page: r.page,
        leadType: r.lead_type ?? settings.default_lead_type ?? null,
        discarded: r.review === 'discarded' ? r.notes?.startsWith('Only a status') ? 'only a status was left' : 'you discarded it in review' : null,
      };
    });
}

export function getDraftView(db: DB, id: string) {
  const d = getDraft(db, id);
  const rows = rowsOf(db, id);
  const source = sourceRowsOf(db, d, rows);
  const settings = JSON.parse(d.settings_json) as DraftSettings;
  const { summary, rows: analyzed } = previewRows(db, d.file_sha256, source, { importRepeatsAsNew: settings.import_repeats_as_new });
  const byRow = new Map(analyzed.map((a) => [a.rowNumber, a]));
  return {
    id: d.id, kind: d.kind, file_name: d.file_name, file_modified: d.file_modified, status: d.status,
    settings,
    progress: d.progress_json ? (JSON.parse(d.progress_json) as Progress) : null,
    summary,
    needs_review: rows.filter((r) => r.review === 'needs_review' && r.extractor !== 'pending').length,
    pending: rows.filter((r) => r.extractor === 'pending').length,
    rows: rows.map((r) => {
      const data = JSON.parse(r.fields_json) as DraftRowData;
      const edits = r.edits_json ? (JSON.parse(r.edits_json) as FieldValues) : null;
      const a = byRow.get(r.row_number);
      return {
        row_number: r.row_number,
        page: r.page,
        review: r.review,
        extractor: r.extractor,
        lead_type: r.lead_type,
        notes: r.notes,
        fields: effectiveFields(data, edits).fields,
        read: data.fields,
        edits,
        extra: data.extra,
        raw: d.kind === 'sheet' ? data.raw : undefined,
        issues: (r.issues_json ? JSON.parse(r.issues_json) : []) as ReadIssue[],
        status: a?.status ?? null,
        status_notes: a ? [...a.errors, ...a.warnings] : [],
        name: a ? [a.lead.first_name, a.lead.last_name].filter(Boolean).join(' ') : null,
        phone: a?.lead.phone_e164 ?? null,
        county: a?.lead.county ?? null,
        county_key: a?.lead.county_key ?? null,
        state: a?.lead.state ?? null,
      };
    }),
  };
}

export function reviewRow(
  db: DB,
  id: string,
  rowNumber: number,
  input: { action: 'ok' | 'discard' | 'reopen' | 'save'; edits?: FieldValues; lead_type?: string | null },
) {
  return db.transaction(() => {
    const d = getDraft(db, id);
    if (d.status === 'committed') throw new DomainError('this import is already finished');
    const r = db.prepare('SELECT * FROM import_draft_row WHERE draft_id = ? AND row_number = ?').get(id, rowNumber) as DraftRowDb | undefined;
    if (!r) throw new DomainError('row not found', 404);
    if (r.extractor === 'pending') throw new DomainError('this page is still being read');
    const data = JSON.parse(r.fields_json) as DraftRowData;
    const edits = { ...(r.edits_json ? JSON.parse(r.edits_json) : {}), ...(input.edits ?? {}) } as FieldValues;
    // Edits equal to what was read are not edits.
    for (const k of Object.keys(edits) as LeadFieldKey[]) if ((data.fields[k] ?? '') === (edits[k] ?? '')) delete edits[k];
    const issues = assessRow(data, edits);
    let review: Review = r.review;
    if (input.action === 'ok') {
      // Your OK confirms anything the reader wasn't sure of; only missing essentials stop it.
      const missing = issues.filter((i) => i.kind === 'missing');
      if (missing.length) throw new DomainError(`Fill in first: ${missing.map((m) => m.message).join('; ')}`);
      review = 'ok';
    } else if (input.action === 'discard') review = 'discarded';
    else if (input.action === 'reopen') review = reviewFor('auto', issues);
    else review = reviewFor(r.review === 'discarded' ? 'discarded' : 'auto', issues);
    if (input.lead_type !== undefined) checkType(db, input.lead_type);
    db.prepare(
      `UPDATE import_draft_row SET edits_json = ?, issues_json = ?, review = ?, lead_type = ?, updated_at = ? WHERE draft_id = ? AND row_number = ?`,
    ).run(
      Object.keys(edits).length ? JSON.stringify(edits) : null, JSON.stringify(issues), review,
      input.lead_type !== undefined ? input.lead_type : r.lead_type, nowIso(), id, rowNumber,
    );
    db.prepare('UPDATE import_draft SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    return { review, issues };
  })();
}

function checkType(db: DB, code: string | null) {
  if (code && !db.prepare('SELECT 1 FROM lead_type WHERE code = ?').get(code)) throw new DomainError(`unknown lead type "${code}"`);
}

/** Sets the lead type on many rows at once: chosen rows, a page range, a county, or all. */
export function setRowsType(
  db: DB,
  id: string,
  sel: { rows?: number[]; from?: number; to?: number; county_key?: string; all?: boolean },
  leadType: string | null,
) {
  checkType(db, leadType);
  const d = getDraft(db, id);
  if (d.status === 'committed') throw new DomainError('this import is already finished');
  const view = getDraftView(db, id);
  const chosen = view.rows.filter(
    (r) =>
      sel.all ||
      sel.rows?.includes(r.row_number) ||
      (sel.from != null && sel.to != null && r.row_number >= sel.from && r.row_number <= sel.to) ||
      (sel.county_key && r.county_key === sel.county_key),
  );
  const up = db.prepare('UPDATE import_draft_row SET lead_type = ?, updated_at = ? WHERE draft_id = ? AND row_number = ?');
  db.transaction(() => {
    for (const r of chosen) up.run(leadType, nowIso(), id, r.row_number);
  })();
  return { updated: chosen.length };
}

export function updateDraftSettings(db: DB, id: string, patch: Partial<DraftSettings>) {
  const d = getDraft(db, id);
  if (patch.default_lead_type !== undefined) checkType(db, patch.default_lead_type);
  const s = { ...(JSON.parse(d.settings_json) as DraftSettings), ...patch };
  db.prepare('UPDATE import_draft SET settings_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(s), nowIso(), id);
  return s;
}

export function deleteDraft(db: DB, id: string) {
  const d = getDraft(db, id);
  if (d.status === 'committed') throw new DomainError('this import is already finished');
  db.transaction(() => {
    db.prepare('DELETE FROM import_draft_row WHERE draft_id = ?').run(id);
    db.prepare("UPDATE import_draft SET status = 'deleted', updated_at = ? WHERE id = ?").run(nowIso(), id);
  })();
  fs.rmSync(d.file_path, { force: true });
}

export function draftFile(db: DB, id: string) {
  const d = getDraft(db, id);
  return { path: d.file_path, kind: d.kind, name: d.file_name };
}

/**
 * Moves the rows that still need a look into a new draft of the same file, so the rest can be imported now.
 * Returns the new draft, or null when there is nothing to set aside (or nothing would be left).
 */
export function setAsideNeedsReview(db: DB, importsDir: string, id: string): { id: string; rows: number } | null {
  const d = getDraft(db, id);
  if (d.status !== 'review') throw new DomainError('this import is not ready to split');
  const counts = db
    .prepare("SELECT COUNT(*) total, SUM(CASE WHEN review = 'needs_review' THEN 1 ELSE 0 END) look FROM import_draft_row WHERE draft_id = ?")
    .get(id) as { total: number; look: number | null };
  const look = counts.look ?? 0;
  if (!look || look === counts.total) return null;
  const newId = uuidv7();
  const newPath = path.join(draftsDir(importsDir), `${newId}${path.extname(d.file_path)}`);
  fs.copyFileSync(d.file_path, newPath);
  fs.chmodSync(newPath, 0o600);
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO import_draft (id, kind, file_name, file_sha256, file_path, file_modified, status, settings_json, progress_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'review', ?, ?, ?, ?)`,
    ).run(newId, d.kind, d.file_name, d.file_sha256, newPath, d.file_modified, d.settings_json, d.progress_json, now, now);
    db.prepare("UPDATE import_draft_row SET draft_id = ? WHERE draft_id = ? AND review = 'needs_review'").run(newId, id);
  })();
  return { id: newId, rows: look };
}

export function commitDraft(db: DB, importsDir: string, id: string, batch: BatchInput) {
  const d = getDraft(db, id);
  if (d.status === 'committed') throw new DomainError('this import is already finished');
  if (d.status === 'reading') throw new DomainError('pages are still being read');
  const rows = rowsOf(db, id);
  const left = rows.filter((r) => r.review === 'needs_review').length;
  if (left) throw new DomainError(`${left} lead${left === 1 ? ' still needs' : 's still need'} a look before importing`, 409);
  const settings = JSON.parse(d.settings_json) as DraftSettings;
  const source = sourceRowsOf(db, d, rows);
  const meta = {
    kind: d.kind, draft_id: d.id, sheet: settings.sheet, mapping: settings.mapping,
    default_lead_type: settings.default_lead_type, prompt_version: d.kind === 'pdf' ? PROMPT_VERSION : undefined,
    readers: [...new Set(rows.map((r) => r.extractor).filter(Boolean))],
  };
  const result = commitRows(db, { fileName: d.file_name, sha256: d.file_sha256 }, source, batch, meta, {
    fileModified: d.file_modified,
    importRepeatsAsNew: settings.import_repeats_as_new,
  });
  const safe = d.file_name.replace(/[^\w.\- ]/g, '_');
  fs.copyFileSync(d.file_path, path.join(importsDir, `${result.batchId}-${safe}`));
  fs.chmodSync(path.join(importsDir, `${result.batchId}-${safe}`), 0o600);
  db.prepare("UPDATE import_draft SET status = 'committed', batch_id = ?, updated_at = ? WHERE id = ?").run(result.batchId, nowIso(), id);
  fs.rmSync(d.file_path, { force: true });
  if (settings.default_lead_type) setSetting(db, 'import.last_lead_type', settings.default_lead_type);
  return result;
}
