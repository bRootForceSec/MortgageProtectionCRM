import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { toText } from './normalize.js';

export interface ParsedSheet {
  name: string;
  headers: string[];
  /** Spreadsheet row number of the header row (1-based). */
  headerRow: number;
  rows: { rowNumber: number; cells: Record<string, string> }[];
}

export interface ParsedFile {
  fileName: string;
  sha256: string;
  sheets: ParsedSheet[];
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function parseSpreadsheet(buf: Buffer, fileName: string): Promise<ParsedFile> {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const lower = fileName.toLowerCase();
  let grids: { name: string; grid: unknown[][] }[];
  if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const delimiter = lower.endsWith('.tsv') ? '\t' : detectDelimiter(text);
    const grid = parseCsv(text, { delimiter, relax_column_count: true, skip_empty_lines: false, bom: true }) as unknown[][];
    grids = [{ name: 'CSV', grid }];
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    grids = wb.worksheets.map((ws) => {
      const grid: unknown[][] = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => {
        const vals = (row.values as unknown[]).slice(1); // exceljs rows are 1-indexed
        grid[n - 1] = vals;
      });
      for (let i = 0; i < grid.length; i++) grid[i] ??= [];
      return { name: ws.name, grid };
    });
  } else {
    throw new Error('Unsupported file type. Use .xlsx or .csv (save older .xls files as .xlsx first).');
  }
  return { fileName, sha256, sheets: grids.map(({ name, grid }) => toSheet(name, grid)).filter((s) => s.headers.length) };
}

function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 1 ? counts[0]![0] : ',';
}

/** The header row is the first row with at least two non-empty cells. */
function toSheet(name: string, grid: unknown[][]): ParsedSheet {
  const hIdx = grid.findIndex((r) => (r ?? []).filter((c) => toText(c) !== '').length >= 2);
  if (hIdx < 0) return { name, headers: [], headerRow: 0, rows: [] };
  const seen = new Map<string, number>();
  const headers = (grid[hIdx] ?? []).map((c, i) => {
    let h = toText(c) || `Column ${i + 1}`;
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    if (n) h = `${h} (${n + 1})`;
    return h;
  });
  const rows: ParsedSheet['rows'] = [];
  for (let i = hIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const cells: Record<string, string> = {};
    let any = false;
    headers.forEach((h, j) => {
      const v = toText(r[j]);
      cells[h] = v;
      if (v) any = true;
    });
    // Extra cells beyond the header row are kept rather than dropped.
    for (let j = headers.length; j < r.length; j++) {
      const v = toText(r[j]);
      if (v) {
        cells[`Column ${j + 1}`] = v;
        any = true;
      }
    }
    if (any) rows.push({ rowNumber: i + 1, cells });
  }
  return { name, headers, headerRow: hIdx + 1, rows };
}
