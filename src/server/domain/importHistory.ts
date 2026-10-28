import type { DB } from '../db/connection.js';
import { batchMatches, groupByImport, type BatchFilter, type BatchListRow, type ImportGroup } from '../../shared/batches.js';

// Past imports: the batch list, and the rows each import left out.

/** Every import batch, newest first, with how many rows went in, were refused, or were repeats. */
export function listImportBatches(db: DB) {
  return db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM import_row r WHERE r.batch_id = b.id) rows_total,
              (SELECT COUNT(*) FROM import_row r WHERE r.batch_id = b.id AND r.status = 'accepted') rows_accepted,
              (SELECT COUNT(*) FROM import_row r WHERE r.batch_id = b.id AND r.status = 'rejected') rows_rejected,
              (SELECT COUNT(*) FROM import_row r WHERE r.batch_id = b.id AND r.status IN ('already_imported','duplicate_in_file')) rows_repeat
       FROM import_batch b ORDER BY b.imported_at DESC`,
    )
    .all();
}

/** Which bulk import each batch came from. */
export function bulkOfBatch(db: DB): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT f.bulk_id, j.value batch_id FROM import_bulk_file f, json_each(f.summary_json, '$.batches') j
       WHERE f.summary_json IS NOT NULL`,
    )
    .all() as { bulk_id: string; batch_id: string }[];
  return new Map(rows.map((r) => [r.batch_id, r.bulk_id]));
}

function batchRows(db: DB): BatchListRow[] {
  const bulkOf = bulkOfBatch(db);
  const rows = db
    .prepare(
      `WITH rs AS (
         SELECT batch_id, COUNT(*) total, SUM(status = 'accepted') accepted, SUM(status = 'rejected') rejected,
                SUM(status IN ('already_imported','duplicate_in_file')) repeats
         FROM import_row GROUP BY batch_id),
       ls AS (
         SELECT l.batch_id, group_concat(DISTINCT coalesce(l.lead_type, '')) types,
                SUM(s.status IN ('new','retry','callback')) left_to_call, SUM(l.price_cents) price
         FROM lead l JOIN lead_state s ON s.lead_id = l.id GROUP BY l.batch_id)
       SELECT b.id, b.name, b.file_name, b.imported_at, coalesce(b.cost_total_cents, ls.price) cost_cents,
              coalesce(rs.total, 0) rows_total, coalesce(rs.accepted, 0) rows_accepted, coalesce(rs.rejected, 0) rows_rejected,
              coalesce(rs.repeats, 0) rows_repeat, ls.types, coalesce(ls.left_to_call, 0) left_to_call
       FROM import_batch b LEFT JOIN rs ON rs.batch_id = b.id LEFT JOIN ls ON ls.batch_id = b.id
       ORDER BY b.imported_at DESC`,
    )
    .all() as (Omit<BatchListRow, 'lead_types' | 'left' | 'bulk_id'> & { types: string | null; left_to_call: number })[];
  return rows.map(({ types, left_to_call, ...r }) => ({
    ...r,
    lead_types: types == null ? [] : types.split(','),
    left: left_to_call,
    bulk_id: bulkOf.get(r.id) ?? null,
  }));
}

function totalsOf(bs: BatchListRow[]): ImportGroup['totals'] {
  const priced = bs.filter((b) => b.cost_cents != null);
  return {
    leads: bs.reduce((n, b) => n + b.rows_accepted, 0),
    rejected: bs.reduce((n, b) => n + b.rows_rejected, 0),
    repeats: bs.reduce((n, b) => n + b.rows_repeat, 0),
    cost_cents: priced.length ? priced.reduce((n, b) => n + b.cost_cents!, 0) : null,
    left: bs.reduce((n, b) => n + b.left, 0),
    lead_types: [...new Set(bs.flatMap((b) => b.lead_types))].sort(),
  };
}

/**
 * Past imports for the batch lists, newest first, a page at a time: each bulk import is one line with its files'
 * batches inside, and a single-file import is a line of its own. With a filter, a bulk import shows only the
 * batches that match. `key` (a batch id, or "bulk:<id>") returns just the line holding it.
 */
export function browseImports(db: DB, f: BatchFilter & { key?: string; limit?: number; offset?: number }) {
  const all = batchRows(db);
  const filtering = !!(f.search?.trim() || f.days || f.lead_type !== undefined || f.left);
  const shown = all.filter((b) => batchMatches(b, f));
  const bulks = db
    .prepare(
      `SELECT k.id, k.created_at, COUNT(x.seq) files, SUM(x.state IN ('queued','reading')) reading,
              SUM(x.state IN ('needs_columns','needs_review')) to_check
       FROM import_bulk k LEFT JOIN import_bulk_file x ON x.bulk_id = k.id AND x.state <> 'removed'
       GROUP BY k.id`,
    )
    .all() as { id: string; created_at: string; files: number; reading: number | null; to_check: number | null }[];
  const bulkInfo = new Map(bulks.map((b) => [b.id, b]));
  const countIn = new Map<string, number>();
  for (const b of all) if (b.bulk_id) countIn.set(b.bulk_id, (countIn.get(b.bulk_id) ?? 0) + 1);

  const groups: ImportGroup[] = groupByImport(shown).map((g) => {
    if (!g.bulk_id) {
      const b = g.rows[0]!;
      return { kind: 'batch', id: b.id, imported_at: b.imported_at, batches: g.rows, batches_total: 1, totals: totalsOf(g.rows) };
    }
    const k = bulkInfo.get(g.bulk_id);
    return {
      kind: 'bulk', id: g.bulk_id, imported_at: k?.created_at ?? g.rows[0]!.imported_at, batches: g.rows,
      batches_total: countIn.get(g.bulk_id) ?? g.rows.length, totals: totalsOf(g.rows),
      bulk: { files: k?.files ?? g.rows.length, reading: k?.reading ?? 0, to_check: k?.to_check ?? 0 },
    };
  });
  // A bulk import still being read (nothing imported yet) shows too, unless you're filtering.
  if (!filtering) {
    for (const k of bulks) {
      if (countIn.has(k.id)) continue;
      groups.push({
        kind: 'bulk', id: k.id, imported_at: k.created_at, batches: [], batches_total: 0, totals: totalsOf([]),
        bulk: { files: k.files, reading: k.reading ?? 0, to_check: k.to_check ?? 0 },
      });
    }
  }
  groups.sort((a, b) => b.imported_at.localeCompare(a.imported_at));

  if (f.key) {
    const bulk = f.key.startsWith('bulk:') ? f.key.slice(5) : null;
    const hit = groups.filter((g) => (bulk ? g.kind === 'bulk' && g.id === bulk : g.batches.some((b) => b.id === f.key)));
    return { groups: hit, total: hit.length };
  }
  const offset = f.offset ?? 0;
  return { groups: groups.slice(offset, offset + (f.limit ?? 25)), total: groups.length };
}

/** Batches imported from a file with this checksum. */
export function batchesFromFile(db: DB, sha256: string) {
  return db.prepare('SELECT id, name, imported_at FROM import_batch WHERE file_sha256 = ?').all(sha256);
}

interface ProblemRow {
  row_number: number;
  status: string;
  errors_json: string | null;
  warnings_json: string | null;
  raw_json: string;
}

/** One left-out row for the problems CSV: its reasons, then the original columns. */
function problemLine(r: ProblemRow) {
  return {
    row_number: r.row_number,
    status: r.status,
    problems: [...JSON.parse(r.errors_json ?? '[]'), ...JSON.parse(r.warnings_json ?? '[]')].join('; '),
    ...JSON.parse(r.raw_json),
  };
}

/** Rows of one import that didn't go in. */
export function importProblems(db: DB, batchId: string) {
  const rows = db
    .prepare("SELECT row_number, status, errors_json, warnings_json, raw_json FROM import_row WHERE batch_id = ? AND status <> 'accepted' ORDER BY row_number")
    .all(batchId) as ProblemRow[];
  return rows.map(problemLine);
}

/** Every lead a bulk import left out (repeats, missing details, discarded), with the file each came from. */
export function bulkImportProblems(db: DB, bulkId: string) {
  const rows = db
    .prepare(
      `SELECT b.name batch, b.file_name file, r.row_number, r.status, r.errors_json, r.warnings_json, r.raw_json
       FROM import_row r JOIN import_batch b ON b.id = r.batch_id
       WHERE r.status <> 'accepted' AND r.batch_id IN (
         SELECT j.value FROM import_bulk_file f, json_each(f.summary_json, '$.batches') j WHERE f.bulk_id = ? AND f.summary_json IS NOT NULL)
       ORDER BY b.imported_at, r.row_number`,
    )
    .all(bulkId) as (ProblemRow & { batch: string; file: string })[];
  return rows.map((r) => ({ file: r.file, batch: r.batch, ...problemLine(r) }));
}
