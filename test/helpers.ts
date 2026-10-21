import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/server/db/connection.js';
import type { Config } from '../src/server/config.js';
import { groupWhere } from '../src/server/domain/groupFilter.js';

export function tempConfig(): Config {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-test-'));
  const c: Config = {
    dataDir,
    dbFile: path.join(dataDir, 'crm.sqlite'),
    backupDir: path.join(dataDir, 'backups'),
    importsDir: path.join(dataDir, 'imports'),
    host: '127.0.0.1',
    port: 5170,
    backupKeep: 3,
    backupAgeRecipient: null,
  };
  for (const d of [c.backupDir, c.importsDir]) fs.mkdirSync(d, { recursive: true });
  return c;
}

export function tempDb() {
  const c = tempConfig();
  return { c, db: openDatabase(c.dbFile) };
}

/** Header row + data rows, shaped like the Claude-extracted lead sheet. */
export const SAMPLE_HEADERS = ['Lead Name', 'Phone', 'Lender', 'Loan Amount', 'Age', 'Co-Borrower', 'Address', 'City', 'State', 'Zip', 'Tobacco', 'Heart Attack', 'Stroke', 'Cancer', 'Diabetes', 'Lead Notes'];

export const SAMPLE_ROWS: (string | number)[][] = [
  ['Jane Doe', '(614) 555-0101', 'Rocket Mortgage', '$286,000', 52, 'Yes', '12 Elm St', 'Columbus', 'OH', '43215', 'No', 'No', 'No', 'No', 'Yes', 'prefers evenings'],
  ['Robert Ray', '614.555.0102', 'Chase', 175000, 61, 'No', '4 Oak Ave', 'Dayton', 'Ohio', '45402', 'Yes', 'No', 'No', 'No', 'No', ''],
  ['Ann Lee', '+1 312 555 0103', 'Wells Fargo', '320k', 45, '', '9 Pine Rd', 'Chicago', 'IL', '60601', 'No', 'No', 'No', 'No', 'No', ''],
  ['No Phone Person', '', 'Chase', '100000', 40, '', '', '', 'TX', '', '', '', '', '', '', ''],
  ['Bad Phone', '555-01', 'Chase', 'lots', 'forty', '', '', '', 'Narnia', '', '', '', '', '', '', ''],
  ['Jane Doe', '(614) 555-0101', 'Rocket Mortgage', '$286,000', 52, 'Yes', '12 Elm St', 'Columbus', 'OH', '43215', 'No', 'No', 'No', 'No', 'Yes', 'prefers evenings'],
  ['John Doe', '(614) 555-0101', 'Rocket Mortgage', '$286,000', 54, 'Yes', '12 Elm St', 'Columbus', 'OH', '43215', 'Yes', 'No', 'No', 'No', 'No', 'co-borrower'],
];

export async function sampleXlsx(rows = SAMPLE_ROWS, headers = SAMPLE_HEADERS, titleRows = 1): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');
  for (let i = 0; i < titleRows; i++) ws.addRow([`Lead export page ${i + 1}`]);
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function sampleCsv(rows = SAMPLE_ROWS, headers = SAMPLE_HEADERS): Buffer {
  const esc = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return Buffer.from([headers, ...rows].map((r) => r.map(esc).join(',')).join('\n'));
}

/**
 * Leads ready to call now, read from lead_state: new leads, and retries or callbacks that are due (or have no time).
 * Tests use it to check what the derived state means for calling.
 */
export function dueLeads(db: import('../src/server/db/connection.js').DB, opts: { counties?: string[]; areaCodes?: string[]; now?: string } = {}) {
  const g = groupWhere('l.county_key', opts);
  return db
    .prepare(
      `SELECT l.id, trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) name, s.status, s.next_due_at,
              coalesce(s.active_phone_e164, l.phone_e164) phone_e164
       FROM lead l JOIN lead_state s ON s.lead_id = l.id
       WHERE (s.status = 'new' OR (s.status IN ('retry','callback') AND (s.next_due_at IS NULL OR s.next_due_at <= @now))) AND ${g.sql}
       ORDER BY name`,
    )
    .all({ now: opts.now ?? new Date().toISOString(), ...g.params }) as { id: string; name: string; status: string; next_due_at: string | null; phone_e164: string | null }[];
}
