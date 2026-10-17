import { describe, it, expect } from 'vitest';
import { tempDb, sampleXlsx, sampleCsv, SAMPLE_ROWS, SAMPLE_HEADERS } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { previewImport, commitImport } from '../../src/server/domain/importer.js';
import { addLeadAction } from '../../src/server/domain/calls.js';

async function load(buf: Buffer, name = 'leads.xlsx') {
  const parsed = await parseSpreadsheet(buf, name);
  const sheet = parsed.sheets[0]!;
  return { parsed, sheet, mapping: suggestMapping(sheet.headers) };
}

describe('lead import', () => {
  it('T1: maps fields correctly from xlsx with a title row above the headers', async () => {
    const { db } = tempDb();
    const { parsed, sheet, mapping } = await load(await sampleXlsx());
    expect(sheet.headerRow).toBe(2);
    expect(sheet.headers).toEqual(SAMPLE_HEADERS);
    const r = commitImport(db, parsed, sheet, mapping, { name: 'Aug aged 30d', cost_total_cents: 40000, purchased_count: 100 });
    const jane = db.prepare("SELECT * FROM lead WHERE first_name = 'Jane'").get() as any;
    expect(jane).toMatchObject({
      last_name: 'Doe', phone_e164: '+16145550101', lender: 'Rocket Mortgage', loan_amount_cents: 28_600_000, age: 52,
      coborrower_signal: 'yes', address_line: '12 Elm St', city: 'Columbus', state: 'OH', zip: '43215',
      time_zone: 'America/New_York', tobacco_raw: 'No', health_diabetes_raw: 'Yes',
    });
    expect(JSON.parse(jane.extra_json)).toEqual({ 'Lead Notes': 'prefers evenings' });
    const robert = db.prepare("SELECT * FROM lead WHERE first_name = 'Robert'").get() as any;
    expect(robert).toMatchObject({ state: 'OH', coborrower_raw: 'No', coborrower_signal: 'unknown', loan_amount_cents: 17_500_000 });
    const batch = db.prepare('SELECT * FROM import_batch WHERE id = ?').get(r.batchId) as any;
    expect(batch).toMatchObject({ cost_total_cents: 40000, cost_per_lead_cents: 400, purchased_count: 100 });
  });

  it('T2: reports malformed rows with reasons and keeps them, without corrupting good rows', async () => {
    const { db } = tempDb();
    const { parsed, sheet, mapping } = await load(await sampleXlsx());
    const { summary, rows } = previewImport(db, parsed.sha256, sheet, mapping);
    expect(summary).toMatchObject({ total: 7, accepted: 4, rejected: 2, duplicate_in_file: 1 });
    const noPhone = rows.find((r) => r.lead.first_name === 'No Phone')!;
    expect(noPhone.status).toBe('rejected');
    expect(noPhone.errors).toContain('no phone number');
    const bad = rows.find((r) => r.lead.last_name === 'Phone' && r.lead.first_name === 'Bad')!;
    expect(bad.errors[0]).toMatch(/not 10 digits/);
    expect(bad.warnings.join(' ')).toMatch(/amount not understood.*age not a whole number.*state not recognized/);
    // Nothing is written by a preview.
    expect((db.prepare('SELECT COUNT(*) n FROM lead').get() as any).n).toBe(0);

    commitImport(db, parsed, sheet, mapping, { name: 'b1' });
    const kept = db.prepare("SELECT status, errors_json FROM import_row WHERE status = 'rejected'").all() as any[];
    expect(kept).toHaveLength(2);
    expect((db.prepare('SELECT COUNT(*) n FROM import_row').get() as any).n).toBe(7);
  });

  it('marks an exact repeated row in the same file, and links same-phone different people', async () => {
    const { db } = tempDb();
    const { parsed, sheet, mapping } = await load(await sampleXlsx());
    const { rows } = previewImport(db, parsed.sha256, sheet, mapping);
    // Row 6 is identical to row 1 → duplicate_in_file; John Doe shares Jane's phone → accepted with a warning.
    expect(rows[5]!.status).toBe('duplicate_in_file');
    const john = rows.find((r) => r.lead.first_name === 'John')!;
    expect(john.status).toBe('accepted');
    expect(john.warnings.join(' ')).toMatch(/co-borrowers often share a phone/);
    commitImport(db, parsed, sheet, mapping, { name: 'b1' });
    expect((db.prepare("SELECT COUNT(*) n FROM lead_link WHERE reason = 'same_phone'").get() as any).n).toBe(1);
  });

  it('T3: re-importing the same file creates no new leads', async () => {
    const { db } = tempDb();
    const buf = await sampleXlsx();
    const a = await load(buf);
    commitImport(db, a.parsed, a.sheet, a.mapping, { name: 'b1' });
    const before = (db.prepare('SELECT COUNT(*) n FROM lead').get() as any).n;
    const b = await load(buf);
    const p = previewImport(db, b.parsed.sha256, b.sheet, b.mapping);
    expect(p.summary.accepted).toBe(0);
    expect(p.summary.already_imported).toBe(4);
    expect(p.summary.file_previously_imported).toHaveLength(1);
    expect(() => commitImport(db, b.parsed, b.sheet, b.mapping, { name: 'b2' })).toThrow(/no new leads/);
    expect((db.prepare('SELECT COUNT(*) n FROM lead').get() as any).n).toBe(before);
  });

  it('re-import of a CSV with one new row adds exactly one lead', async () => {
    const { db } = tempDb();
    const a = await load(sampleCsv(), 'a.csv');
    commitImport(db, a.parsed, a.sheet, a.mapping, { name: 'b1' });
    const more = [...SAMPLE_ROWS, ['Zed New', '(213) 555-0199', 'Chase', '90000', 33, '', '', 'LA', 'CA', '90001', '', '', '', '', '', '']];
    const b = await load(sampleCsv(more), 'b.csv');
    const r = commitImport(db, b.parsed, b.sheet, b.mapping, { name: 'b2' });
    expect(r.summary.accepted).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM lead').get() as any).n).toBe(5);
  });

  it('can deliberately import repeated leads as a new purchase', async () => {
    const { db } = tempDb();
    const a = await load(sampleCsv(), 'a.csv');
    commitImport(db, a.parsed, a.sheet, a.mapping, { name: 'b1' });
    const r = commitImport(db, a.parsed, a.sheet, a.mapping, { name: 'b2 rebought' }, { importRepeatsAsNew: true });
    expect(r.summary.accepted).toBe(4);
    // The new copies are linked to the originals as possible duplicates.
    expect((db.prepare('SELECT COUNT(*) n FROM lead_link').get() as any).n).toBeGreaterThanOrEqual(4);
  });

  it('flags phones that belong to a dead lead', async () => {
    const { db } = tempDb();
    const a = await load(sampleCsv(), 'a.csv');
    commitImport(db, a.parsed, a.sheet, a.mapping, { name: 'b1' });
    const ann = db.prepare("SELECT id FROM lead WHERE first_name = 'Ann'").get() as any;
    addLeadAction(db, ann.id, 'mark_dead', 'asked not to be called');
    const rows = [['Ann B Lee', '312-555-0103', 'Chase', '1', 46, '', '', '', 'IL', '', '', '', '', '', '', '']];
    const b = await load(sampleCsv(rows), 'b.csv');
    const p = previewImport(db, b.parsed.sha256, b.sheet, b.mapping);
    expect(p.summary.in_dead_pile).toBe(1);
    expect(p.rows[0]!.status).toBe('accepted');
    expect(p.rows[0]!.warnings.join(' ')).toMatch(/dead pile/);
  });

  it('rejects unsupported files clearly', async () => {
    await expect(parseSpreadsheet(Buffer.from('x'), 'leads.pdf')).rejects.toThrow(/Unsupported/);
  });
});
