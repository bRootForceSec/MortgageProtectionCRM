import ExcelJS from 'exceljs';
import { tableNames, type DB } from '../db/connection.js';
import { CURRENT_OUTCOME } from '../db/sql.js';

// Exports read straight from the tables so nothing is lost or reinterpreted.
// Health columns are excluded unless explicitly requested.

export const EXPORT_TABLES = ['leads', 'calls', 'outcomes', 'events', 'notes', 'batches', 'import_rows', 'numbers'] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

const HEALTH_COLS = ['tobacco_raw', 'health_heart_raw', 'health_stroke_raw', 'health_cancer_raw', 'health_diabetes_raw'];

export function exportRows(db: DB, table: ExportTable, opts: { includeHealth?: boolean } = {}): Record<string, unknown>[] {
  const q: Record<ExportTable, string> = {
    leads: `SELECT l.*, (SELECT group_concat(trim(coalesce(p.label || ': ', '') || coalesce(p.e164, p.raw)), '; ')
                          FROM (SELECT * FROM lead_other_phone WHERE lead_id = l.id ORDER BY pos) p) other_phones,
            b.name batch_name, s.status, s.attempts_total, s.last_call_at, s.last_outcome_code, s.next_due_at
            FROM lead l JOIN import_batch b ON b.id = l.batch_id LEFT JOIN lead_state s ON s.lead_id = l.id ORDER BY l.created_at`,
    calls: `SELECT c.*, (SELECT o.outcome_code FROM call_outcome o WHERE o.call_id = c.id
              AND ${CURRENT_OUTCOME} ORDER BY o.entered_at DESC LIMIT 1) current_outcome
            FROM call c ORDER BY c.requested_at`,
    outcomes: 'SELECT * FROM call_outcome ORDER BY entered_at',
    events: 'SELECT * FROM call_event ORDER BY received_at',
    notes: 'SELECT * FROM note ORDER BY created_at',
    batches: 'SELECT * FROM import_batch ORDER BY imported_at',
    import_rows: 'SELECT * FROM import_row ORDER BY batch_id, row_number',
    numbers: 'SELECT * FROM caller_number ORDER BY created_at',
  };
  let rows = db.prepare(q[table]).all() as Record<string, unknown>[];
  if (!opts.includeHealth) {
    rows = rows.map((r) => {
      const o = { ...r };
      for (const c of HEALTH_COLS) delete o[c];
      // import_row.raw_json holds the original cells, which may include health columns.
      // Original cells and unmapped columns may include health data, so they are omitted too.
      const omitted = '(omitted: may contain health data; export with health fields to include)';
      if (table === 'import_rows') o.raw_json = omitted;
      if (table === 'leads' && o.extra_json) o.extra_json = omitted;
      return o;
    });
  }
  return rows;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Prevent spreadsheet formula injection when the CSV is opened in Excel.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

export async function toXlsx(sheets: { name: string; rows: Record<string, unknown>[] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    if (!s.rows.length) continue;
    const cols = Object.keys(s.rows[0]!);
    ws.addRow(cols);
    ws.getRow(1).font = { bold: true };
    for (const r of s.rows) {
      ws.addRow(cols.map((c) => {
        const v = r[c];
        // Store text as text so Excel never evaluates a formula from lead data.
        return typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v;
      }));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Full portable dump of every table, as JSON. */
export function fullJsonDump(db: DB) {
  const out: Record<string, unknown[]> = {};
  for (const t of tableNames(db)) out[t] = db.prepare(`SELECT * FROM "${t}"`).all();
  return { exported_at: new Date().toISOString(), format: 'mpcrm-dump-v1', tables: out };
}
