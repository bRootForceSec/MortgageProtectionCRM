import { createHash } from 'node:crypto';
import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { parseSpreadsheet, MAX_UPLOAD_BYTES, type ParsedSheet } from './spreadsheet.js';
import { suggestMapping, validateMapping, type ColumnMapping } from './mapping.js';
import { savedMappingFor, MappingError } from './importer.js';
import {
  createPdfDraft, createSheetDraft, commitDraft, deleteDraft, getDraftView, setAsideNeedsReview, type DraftWorker,
} from './drafts.js';
import { addBatchToCallList } from './callList.js';
import type { DraftProgress } from '../../shared/drafts.js';

// Bulk import: many lead files, or a whole folder, in one go.
// Each file still becomes its own draft and its own batch, exactly as if it was imported on its own.
// Spreadsheets are imported as each one arrives. PDFs are read a few at a time in the background, then imported.
// Leads that need a look are put aside in "Imports to finish" so the rest of the file goes in now.

export interface BulkSettings {
  lead_type: string | null;
  add_to_call_list: boolean;
  /** Import the complete leads of a file now and put the ones that need a look aside (else the whole file waits). */
  import_ready_now: boolean;
}

export type BulkFileState =
  | 'queued' | 'reading' | 'needs_columns' | 'needs_review' | 'imported' | 'nothing_new' | 'failed' | 'removed';

export interface BulkFileSummary {
  leads: number;
  repeats: number;
  not_imported: number;
  to_check: number;
  added_to_call_list: number;
  batches: string[];
}

interface BulkFileDb {
  bulk_id: string;
  seq: number;
  file_name: string;
  rel_path: string | null;
  part: string | null;
  size_bytes: number | null;
  file_sha256: string | null;
  state: BulkFileState;
  draft_id: string | null;
  batch_id: string | null;
  message: string | null;
  summary_json: string | null;
  created_at: string;
  updated_at: string;
}

const SHEET_EXT = /\.(xlsx|xlsm|csv|tsv|txt)$/i;
const emptySummary = (): BulkFileSummary => ({ leads: 0, repeats: 0, not_imported: 0, to_check: 0, added_to_call_list: 0, batches: [] });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The batch is named after the file, like a single import. */
export function batchNameFor(fileName: string, part?: string | null) {
  const base = fileName.replace(/\.(pdf|xlsx|xlsm|csv|tsv|txt)$/i, '').slice(0, 180) || 'Leads';
  return part ? `${base} (part ${part})` : base;
}

/**
 * Big spreadsheets go in as parts of this many rows, each its own batch. Each part takes a second or two,
 * and the app answers other requests (logging a call, the call list) between parts instead of stalling.
 */
export const PART_ROWS = 10_000;

/** A sheet that can be imported without you matching columns: a saved or guessed match with a phone and a name. */
export function usableSheet(db: DB, sheets: ParsedSheet[]): { sheet: ParsedSheet; mapping: ColumnMapping; others: string[] } | null {
  const usable = sheets
    .map((sheet) => ({ sheet, mapping: savedMappingFor(db, sheet.headers) ?? suggestMapping(sheet.headers) }))
    .filter((s) => s.sheet.rows.length > 0 && validateMapping(s.mapping, s.sheet.headers).length === 0);
  if (!usable.length) return null;
  return { ...usable[0]!, others: usable.slice(1).map((s) => s.sheet.name) };
}

function batchCounts(db: DB, batchId: string) {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM import_row WHERE batch_id = ? GROUP BY status').all(batchId) as { status: string; n: number }[];
  const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { leads: n('accepted'), repeats: n('duplicate_in_file') + n('already_imported'), not_imported: n('rejected') };
}

export class BulkImporter {
  /** PDFs read at the same time (each reads two pages at a time), so a folder of PDFs doesn't flood the AI. */
  maxReading = 2;
  partRows = PART_ROWS;
  private reading = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private db: DB, private importsDir: string, private worker: DraftWorker) {}

  create(settings: Partial<BulkSettings>) {
    const s: BulkSettings = {
      lead_type: settings.lead_type ?? null,
      add_to_call_list: settings.add_to_call_list ?? false,
      import_ready_now: settings.import_ready_now ?? true,
    };
    if (s.lead_type && !this.db.prepare('SELECT 1 FROM lead_type WHERE code = ?').get(s.lead_type)) {
      throw new DomainError(`unknown lead type "${s.lead_type}"`);
    }
    const id = uuidv7();
    const now = nowIso();
    this.db.prepare('INSERT INTO import_bulk (id, settings_json, created_at, updated_at) VALUES (?,?,?,?)').run(id, JSON.stringify(s), now, now);
    return { id, settings: s };
  }

  private bulk(id: string) {
    const b = this.db.prepare('SELECT * FROM import_bulk WHERE id = ?').get(id) as { id: string; settings_json: string; created_at: string; updated_at: string } | undefined;
    if (!b) throw new DomainError('bulk import not found', 404);
    return { ...b, settings: JSON.parse(b.settings_json) as BulkSettings };
  }

  private file(bulkId: string, seq: number) {
    return this.db.prepare('SELECT * FROM import_bulk_file WHERE bulk_id = ? AND seq = ?').get(bulkId, seq) as BulkFileDb;
  }

  private update(f: BulkFileDb, patch: Partial<Pick<BulkFileDb, 'state' | 'draft_id' | 'batch_id' | 'message'>> & { summary?: BulkFileSummary }) {
    const next = { ...f, ...patch, summary_json: patch.summary ? JSON.stringify(patch.summary) : f.summary_json, updated_at: nowIso() };
    this.db
      .prepare('UPDATE import_bulk_file SET state = ?, draft_id = ?, batch_id = ?, message = ?, summary_json = ?, updated_at = ? WHERE bulk_id = ? AND seq = ?')
      .run(next.state, next.draft_id, next.batch_id, next.message, next.summary_json, next.updated_at, f.bulk_id, f.seq);
    this.db.prepare('UPDATE import_bulk SET updated_at = ? WHERE id = ?').run(next.updated_at, f.bulk_id);
    return next;
  }

  /**
   * Takes one file of a bulk import. Spreadsheets are imported before this returns (in parts when big);
   * PDFs are queued for reading. Returns the file's row, or one row per part.
   */
  async addFile(bulkId: string, file: { fileName: string; relPath?: string | null; bytes: Buffer; fileModified?: string | null }) {
    const bulk = this.bulk(bulkId);
    const sha = createHash('sha256').update(file.bytes).digest('hex');
    const now = nowIso();
    const seq = ((this.db.prepare('SELECT max(seq) m FROM import_bulk_file WHERE bulk_id = ?').get(bulkId) as { m: number | null }).m ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO import_bulk_file (bulk_id, seq, file_name, rel_path, size_bytes, file_sha256, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'queued',?,?)`,
      )
      .run(bulkId, seq, file.fileName, file.relPath ?? null, file.bytes.length, sha, now, now);
    let f = this.file(bulkId, seq);
    const fail = (state: BulkFileState, message: string) => [this.view(this.update(f, { state, message }))];

    const isPdf = file.bytes.subarray(0, 5).toString('latin1') === '%PDF-';
    if (!isPdf && !SHEET_EXT.test(file.fileName)) return fail('failed', 'Not a lead file. Use PDF, Excel (.xlsx) or CSV.');
    if (!file.bytes.length) return fail('failed', 'The file is empty.');

    // The same file twice (copied into two folders, or imported before) is skipped, so a scan isn't read and paid for twice.
    const before = this.db.prepare('SELECT name FROM import_batch WHERE file_sha256 = ? ORDER BY imported_at LIMIT 1').get(sha) as { name: string } | undefined;
    if (before) return fail('nothing_new', `This exact file was imported before, as "${before.name}".`);
    const twin = this.db
      .prepare(
        `SELECT file_name FROM import_bulk_file WHERE file_sha256 = ? AND NOT (bulk_id = ? AND seq = ?)
         AND state IN ('queued','reading','needs_review','imported') LIMIT 1`,
      )
      .get(sha, bulkId, seq) as { file_name: string } | undefined;
    if (twin) return fail('nothing_new', `Same file as ${twin.file_name}, which is already being imported.`);
    const waiting = this.db.prepare("SELECT 1 FROM import_draft WHERE file_sha256 = ? AND status IN ('reading','review') LIMIT 1").get(sha);
    if (waiting) return fail('nothing_new', 'This file is already waiting in "Imports to finish".');

    const typeSetting = bulk.settings.lead_type ? { default_lead_type: bulk.settings.lead_type } : {};
    if (isPdf) {
      const { id } = createPdfDraft(this.db, this.importsDir, { fileName: file.fileName, bytes: file.bytes, fileModified: file.fileModified }, typeSetting);
      f = this.update(f, { draft_id: id });
      this.pump();
      return [this.view(this.file(bulkId, seq))];
    }

    if (file.bytes.length > MAX_UPLOAD_BYTES) {
      return fail('failed', `Too big for one spreadsheet (over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB). Split it into smaller files.`);
    }
    let sheets: ParsedSheet[];
    try {
      sheets = (await parseSpreadsheet(file.bytes, file.fileName)).sheets;
    } catch (e: any) {
      return fail('failed', `Could not read this file: ${e.message}`);
    }
    const pick = usableSheet(this.db, sheets);
    if (!pick) {
      return fail(
        'needs_columns',
        sheets.some((s) => s.rows.length)
          ? "The columns couldn't be matched (a phone and a name are needed). Import this file on its own once to match them; files laid out the same way then go in by themselves."
          : 'No leads found in this file.',
      );
    }
    const note = pick.others.length
      ? `Only the "${pick.sheet.name}" sheet was imported; ${pick.others.join(', ')} also look like leads. Import the file on its own to pick another sheet.`
      : null;
    const all = pick.sheet.rows;
    const parts = Math.max(1, Math.ceil(all.length / this.partRows));
    const files: BulkFileDb[] = [f];
    // One row per part, made up front so the run shows the whole file straight away.
    for (let i = 2; i <= parts; i++) {
      const at = nowIso();
      this.db
        .prepare(
          `INSERT INTO import_bulk_file (bulk_id, seq, file_name, rel_path, size_bytes, file_sha256, state, created_at, updated_at)
           VALUES (?, (SELECT max(seq) + 1 FROM import_bulk_file WHERE bulk_id = ?), ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(bulkId, bulkId, file.fileName, file.relPath ?? null, file.bytes.length, sha, at, at);
      files.push(this.db.prepare('SELECT * FROM import_bulk_file WHERE bulk_id = ? ORDER BY seq DESC LIMIT 1').get(bulkId) as BulkFileDb);
    }
    for (let i = 0; i < parts; i++) {
      const part = parts > 1 ? `${i + 1} of ${parts}` : null;
      if (part) this.db.prepare('UPDATE import_bulk_file SET part = ? WHERE bulk_id = ? AND seq = ?').run(part, bulkId, files[i]!.seq);
      let pf = this.file(bulkId, files[i]!.seq);
      try {
        const sheet = parts > 1 ? { ...pick.sheet, rows: all.slice(i * this.partRows, (i + 1) * this.partRows) } : pick.sheet;
        const { id } = createSheetDraft(
          this.db, this.importsDir, { fileName: file.fileName, sha256: sha, bytes: file.bytes, fileModified: file.fileModified },
          sheet, pick.mapping, typeSetting,
        );
        pf = this.update(pf, { draft_id: id, message: note });
        this.settle(bulkId, pf.seq);
      } catch (e: any) {
        this.update(pf, { state: e instanceof MappingError ? 'needs_columns' : 'failed', message: e.message });
      }
      // Let other requests in between parts.
      if (i < parts - 1) await new Promise((r) => setImmediate(r));
    }
    return files.map((x) => this.view(this.file(bulkId, x.seq)));
  }

  /** Imports a file whose draft is ready: everything, or the complete leads with the rest put aside to check. */
  private settle(bulkId: string, seq: number) {
    const f = this.file(bulkId, seq);
    if (!f.draft_id || !['queued', 'reading'].includes(f.state)) return;
    const d = this.db.prepare('SELECT status, progress_json FROM import_draft WHERE id = ?').get(f.draft_id) as { status: string; progress_json: string | null };
    if (d.status === 'reading') return;
    if (d.status !== 'review') return void this.refreshOne(f);
    const { settings } = this.bulk(bulkId);
    const counts = this.db
      .prepare("SELECT COUNT(*) total, SUM(CASE WHEN review = 'needs_review' THEN 1 ELSE 0 END) look FROM import_draft_row WHERE draft_id = ?")
      .get(f.draft_id) as { total: number; look: number | null };
    const look = counts.look ?? 0;
    const error = d.progress_json ? (JSON.parse(d.progress_json) as DraftProgress).error : null;
    if (error || (look && (!settings.import_ready_now || look === counts.total))) {
      const summary = { ...emptySummary(), to_check: look };
      this.update(f, { state: 'needs_review', summary, message: error ? `Reading stopped: ${error}` : `${plural(look, 'lead needs', 'leads need')} a look.` });
      return;
    }
    const aside = look ? setAsideNeedsReview(this.db, this.importsDir, f.draft_id) : null;
    try {
      const r = commitDraft(this.db, this.importsDir, f.draft_id, { name: batchNameFor(f.file_name, f.part), lead_type: settings.lead_type });
      const added = settings.add_to_call_list ? addBatchToCallList(this.db, r.batchId).added : 0;
      const summary: BulkFileSummary = {
        leads: r.summary.accepted,
        repeats: r.summary.duplicate_in_file + r.summary.already_imported,
        not_imported: r.summary.rejected,
        to_check: aside?.rows ?? 0,
        added_to_call_list: added,
        batches: [r.batchId],
      };
      this.update(f, {
        state: aside ? 'needs_review' : 'imported', batch_id: r.batchId, draft_id: aside?.id ?? f.draft_id, summary,
        message: aside ? `${plural(aside.rows, 'lead was', 'leads were')} put aside to check in "Imports to finish".` : f.message,
      });
    } catch (e: any) {
      if (e instanceof MappingError) {
        // Nothing new in it: every lead was a repeat, discarded or missing its details.
        const s = getDraftView(this.db, f.draft_id).summary;
        deleteDraft(this.db, f.draft_id);
        const summary = { ...emptySummary(), repeats: s.duplicate_in_file + s.already_imported, not_imported: s.rejected, to_check: aside?.rows ?? 0 };
        this.update(f, {
          state: aside ? 'needs_review' : 'nothing_new', draft_id: aside?.id ?? f.draft_id, summary,
          message: aside ? `${plural(aside.rows, 'lead needs', 'leads need')} a look; the rest were repeats or incomplete.` : 'No new leads: every one was already imported, a repeat, or incomplete.',
        });
        return;
      }
      this.update(f, { state: 'failed', message: `Couldn't import: ${e.message}. It's kept in "Imports to finish".` });
    }
  }

  /** Brings a file up to date after you finished (or deleted) its draft on the import screen. */
  private refreshOne(f: BulkFileDb) {
    if (!f.draft_id) return;
    const d = this.db.prepare('SELECT status, batch_id FROM import_draft WHERE id = ?').get(f.draft_id) as { status: string; batch_id: string | null } | undefined;
    if (!d) return;
    if (f.state === 'queued' || f.state === 'reading') {
      if (d.status === 'review' && !this.reading.has(f.draft_id)) this.settle(f.bulk_id, f.seq);
      else if (d.status === 'committed' || d.status === 'deleted') this.finishChecked(f, d);
      return;
    }
    if (f.state === 'needs_review' || f.state === 'failed') this.finishChecked(f, d);
  }

  private finishChecked(f: BulkFileDb, d: { status: string; batch_id: string | null }) {
    const s: BulkFileSummary = f.summary_json ? JSON.parse(f.summary_json) : emptySummary();
    if (d.status === 'committed' && d.batch_id && !s.batches.includes(d.batch_id)) {
      const c = batchCounts(this.db, d.batch_id);
      s.leads += c.leads;
      s.repeats += c.repeats;
      s.not_imported += c.not_imported;
      s.to_check = 0;
      s.batches.push(d.batch_id);
      this.update(f, { state: 'imported', batch_id: f.batch_id ?? d.batch_id, summary: s, message: null });
    } else if (d.status === 'deleted') {
      s.to_check = 0;
      this.update(f, { state: s.leads ? 'imported' : 'removed', summary: s, message: s.leads ? f.message : 'You deleted this import.' });
    }
  }

  /** Called before the database closes: files being read are left as they are and resume on the next start. */
  stop() {
    this.stopped = true;
  }

  /** Starts reading queued PDFs, a few at a time. */
  pump() {
    if (this.stopped) return;
    const waiting = this.db
      .prepare(
        `SELECT f.bulk_id, f.seq, f.draft_id FROM import_bulk_file f JOIN import_draft d ON d.id = f.draft_id
         WHERE f.state IN ('queued','reading') AND d.status = 'reading' ORDER BY f.created_at, f.seq`,
      )
      .all() as { bulk_id: string; seq: number; draft_id: string }[];
    for (const w of waiting) {
      if (this.reading.size >= this.maxReading) break;
      if (this.reading.has(w.draft_id)) continue;
      this.db.prepare("UPDATE import_bulk_file SET state = 'reading', updated_at = ? WHERE bulk_id = ? AND seq = ?").run(nowIso(), w.bulk_id, w.seq);
      const p = this.worker
        .run(w.draft_id)
        .finally(() => {
          this.reading.delete(w.draft_id);
          if (this.stopped) return;
          try {
            this.settle(w.bulk_id, w.seq);
          } catch (e: any) {
            const f = this.file(w.bulk_id, w.seq);
            if (f) this.update(f, { state: 'failed', message: `Couldn't import: ${e.message}` });
          }
          this.pump();
        });
      this.reading.set(w.draft_id, p);
    }
  }

  /** After a restart: import what finished reading and carry on reading the rest. */
  resume() {
    const open = this.db.prepare("SELECT * FROM import_bulk_file WHERE state IN ('queued','reading')").all() as BulkFileDb[];
    for (const f of open) {
      try {
        this.refreshOne(f);
      } catch {
        /* shown as is; the next look tries again */
      }
    }
    this.pump();
  }

  /** For tests: resolves once nothing is being read. */
  async whenIdle() {
    while (this.reading.size) await Promise.all(this.reading.values());
  }

  private view(f: BulkFileDb) {
    const progress = f.draft_id && (f.state === 'queued' || f.state === 'reading')
      ? ((this.db.prepare('SELECT progress_json FROM import_draft WHERE id = ?').get(f.draft_id) as { progress_json: string | null } | undefined)?.progress_json ?? null)
      : null;
    return {
      seq: f.seq, file_name: f.file_name, rel_path: f.rel_path, part: f.part, size_bytes: f.size_bytes, state: f.state, draft_id: f.draft_id,
      batch_id: f.batch_id, message: f.message,
      summary: (f.summary_json ? JSON.parse(f.summary_json) : emptySummary()) as BulkFileSummary,
      progress: progress ? (JSON.parse(progress) as DraftProgress) : null,
    };
  }

  status(bulkId: string) {
    const bulk = this.bulk(bulkId);
    const rows = () => this.db.prepare('SELECT * FROM import_bulk_file WHERE bulk_id = ? ORDER BY seq').all(bulkId) as BulkFileDb[];
    for (const f of rows()) if (['queued', 'reading', 'needs_review', 'failed'].includes(f.state)) this.refreshOne(f);
    const files = rows().map((f) => this.view(f));
    const count = (...s: BulkFileState[]) => files.filter((f) => s.includes(f.state)).length;
    const sum = (k: keyof Omit<BulkFileSummary, 'batches'>) => files.reduce((a, f) => a + f.summary[k], 0);
    return {
      id: bulk.id, created_at: bulk.created_at, updated_at: bulk.updated_at, settings: bulk.settings,
      totals: {
        files: files.length,
        waiting: count('queued', 'reading'),
        imported_files: count('imported'),
        needs_review_files: count('needs_review'),
        needs_columns_files: count('needs_columns'),
        nothing_new_files: count('nothing_new'),
        failed_files: count('failed'),
        leads: sum('leads'),
        repeats: sum('repeats'),
        not_imported: sum('not_imported'),
        to_check: sum('to_check'),
        added_to_call_list: sum('added_to_call_list'),
      },
      files,
    };
  }

  list(limit = 10) {
    const ids = this.db.prepare('SELECT id FROM import_bulk ORDER BY created_at DESC LIMIT ?').all(limit) as { id: string }[];
    return ids.map(({ id }) => {
      const s = this.status(id);
      return { id: s.id, created_at: s.created_at, updated_at: s.updated_at, totals: s.totals };
    });
  }
}
