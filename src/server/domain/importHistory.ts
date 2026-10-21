import type { DB } from '../db/connection.js';

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
