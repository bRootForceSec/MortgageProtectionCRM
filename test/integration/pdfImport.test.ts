import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tempDb, tempConfig } from '../helpers.js';
import { makeLeadPdf, FAKE } from '../pdfFixtures.js';
import { readPdfText } from '../../src/server/domain/pdfReader.js';
import {
  createPdfDraft, createSheetDraft, DraftWorker, getDraftView, reviewRow, setRowsType, commitDraft, deleteDraft, listDrafts,
} from '../../src/server/domain/drafts.js';
import { Secrets } from '../../src/server/ai/settings.js';
import type { PageReader } from '../../src/server/ai/readers.js';
import { AiError } from '../../src/server/ai/readers.js';
import { getQueue } from '../../src/server/domain/queue.js';
import Database from 'better-sqlite3';
import { migrate } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';
import type { ParsedSheet } from '../../src/server/domain/spreadsheet.js';

/** Stands in for Claude: answers for a scanned card, with one digit group it isn't sure of. */
const fakeReader = (calls: number[] = []): PageReader => ({
  name: 'ai:fake:test',
  async read() {
    calls.push(1);
    return {
      extractor: 'ai:fake:test',
      cost_usd: 0.002,
      answer: {
        is_lead: true,
        layout: 'mailer_card',
        fields: {
          full_name: 'Casey Cardholder', coborrower: null, age: null, lender: 'HALLMARK HM MTG LLC', loan_amount: '$147,184',
          address: '2505 Sample Dr', city: 'Fort Wayne', state: 'IN', zip: '46809', county: null, source_lead_id: null,
          callin_date: null, phone: null, alt_phone: null, called_from: null,
        },
        uncertain: [{ field: 'phone', best_reading: '260-555-0186', reason: 'the middle digits are hard to read' }],
        notes: 'Mailer card; phone is handwritten.',
      },
    };
  },
});

describe('PDF page reader', () => {
  it('reads typed pages by label and column, joins two-line names, flags double values, and handles rotated pages', async () => {
    const pdf = await makeLeadPdf([FAKE[0]!, 'scan', FAKE[1]!]);
    const pages = await readPdfText(pdf);
    expect(pages.map((p) => p.kind)).toEqual(['text', 'no_text', 'text']);
    expect(pages[0]!.fields).toMatchObject({
      source_lead_id: '900000001', callin_date: '7/15/2026 11:31 AM EDT', full_name: 'ALEX SAMPLEPERSON', age: '61',
      coborrower: 'No', lender: 'EXAMPLE FEDERAL C', address: '100 W TEST ST', city: 'SOUTH BEND', state: 'IN', zip: '46619',
      county: 'ST JOSEPH', phone: '(574) 555-0100', phone3: '(574) 555-0100',
    });
    expect(pages[0]!.fields.phone2).toBeUndefined();
    expect(pages[0]!.extra['Last Action']).toBe('INCOMPLETE');
    // Rotated page with a hidden second Last Action and an alternate number.
    const p2 = pages[2]!;
    expect(p2.fields).toMatchObject({ full_name: 'JORDAN TESTER', age: '54', zip: '46514', phone: '(574) 555-0112', phone2: '(574) 555-0113', phone3: '(574) 555-0111', tobacco: 'No' });
    expect(p2.issues).toEqual([expect.objectContaining({ field: 'extra:Last Action', blocking: false })]);
    expect(p2.extra['Health history (heart attack, stroke, cancer, diabetes)']).toBe('No');
  });
});

describe('PDF import drafts', () => {
  async function setup(pages: Parameters<typeof makeLeadPdf>[0], reader: PageReader | null = fakeReader()) {
    const { c, db } = tempDb();
    const worker = new DraftWorker(db, Secrets.inDataDir(c.dataDir));
    worker.readerOverride = reader;
    const bytes = Buffer.from(await makeLeadPdf(pages));
    const { id } = createPdfDraft(db, c.importsDir, { fileName: 'IN_574_1-4.pdf', bytes, fileModified: '2026-10-01T12:00:00.000Z' });
    await worker.run(id);
    return { c, db, worker, id };
  }

  it('reads typed pages itself, sends scans to the AI, and holds the import until the scan is reviewed', async () => {
    const calls: number[] = [];
    const dup = { ...FAKE[0]!, name: ['ALEX', 'SAMPLEPERSON'] }; // same lead printed twice
    const { c, db, id } = await setup([FAKE[0]!, 'scan', FAKE[1]!, dup], fakeReader(calls));
    expect(calls.length).toBe(1);
    let v = getDraftView(db, id);
    expect(v.status).toBe('review');
    expect(v.progress).toMatchObject({ phase: 'done', total: 4, ai_total: 1, ai_done: 1, ai_failed: 0, reader: 'ai:fake:test' });
    expect(v.rows.map((r) => r.review)).toEqual(['auto', 'needs_review', 'auto', 'auto']);
    const scan = v.rows[1]!;
    expect(scan.extractor).toBe('ai:fake:test');
    expect(scan.issues.find((i) => i.field === 'phone')!.message).toMatch(/best reading: 260-555-0186/);
    expect(v.rows[3]!.status).toBe('duplicate_in_file');
    // Counties come from the page ("ELKHART COUNTY" is Elkhart), or from the ZIP when the page has none.
    expect(v.summary.by_county.map((x) => [x.county_key, x.count])).toEqual([['IN|ST JOSEPH', 1], ['IN|ELKHART', 1]]);

    expect(() => commitDraft(db, c.importsDir, id, { name: 'Oct order' })).toThrow(/1 lead still needs a look/);
    expect(() => reviewRow(db, id, 2, { action: 'ok' })).toThrow(/Fill in first: no phone number/);
    reviewRow(db, id, 2, { action: 'ok', edits: { phone: '(260) 555-0186' } });

    // Mixed order: the scan is a different lead type, chosen by page.
    expect(setRowsType(db, id, { from: 2, to: 2 }, 'B').updated).toBe(1);
    v = getDraftView(db, id);
    expect(v.summary.by_type).toEqual(expect.arrayContaining([{ lead_type: 'D', count: 2 }, { lead_type: 'B', count: 1 }]));

    const r = commitDraft(db, c.importsDir, id, { name: 'Oct order' });
    expect(r.summary.accepted).toBe(3);
    const leads = db.prepare('SELECT * FROM lead ORDER BY source_page').all() as any[];
    expect(leads.map((l) => [l.source_page, l.county, l.county_source, l.lead_type, l.price_cents])).toEqual([
      [1, 'St. Joseph', 'page', 'D', 100],
      [2, 'Allen', 'zip', 'B', 700],
      [3, 'Elkhart', 'page', 'D', 100],
    ]);
    expect(leads[2]).toMatchObject({ phone_e164: '+15745550112', phone2_e164: '+15745550113', phone3_e164: '+15745550111', source_lead_id: '900000002' });
    expect(leads[0]).toMatchObject({ first_name: 'Alex', last_name: 'Sampleperson', callin_at: '2026-07-15T15:31:00.000Z' });
    const batch = db.prepare('SELECT * FROM import_batch').get() as any;
    expect(batch.cost_total_cents).toBe(900); // 2 D leads + 1 B lead
    // Enough is kept to rebuild a spreadsheet later: what was read, by what, and what you changed.
    const raw = JSON.parse((db.prepare('SELECT raw_json FROM import_row WHERE row_number = 2').get() as any).raw_json);
    expect(raw).toMatchObject({ __page: '2', __extractor: 'ai:fake:test', __prompt_version: 'lead-page-v1', __edited: '{"phone":"(260) 555-0186"}' });
    expect(fs.readdirSync(c.importsDir).some((f) => f.endsWith('IN_574_1-4.pdf'))).toBe(true);
    expect(listDrafts(db)).toEqual([]);
  });

  it('a scan the AI cannot read, or with no AI set up, is left for you to type in; discard removes it', async () => {
    const failing: PageReader = { name: 'ai:fail', read: async () => { throw new AiError('no network'); } };
    const { c, db, id } = await setup([FAKE[0]!, 'scan'], failing);
    let v = getDraftView(db, id);
    expect(v.progress).toMatchObject({ ai_failed: 1 });
    expect(v.rows[1]!.issues[0]!.message).toMatch(/couldn't read this page \(no network\)/);
    reviewRow(db, id, 2, { action: 'discard' });
    const r = commitDraft(db, c.importsDir, id, { name: 'x' });
    expect(r.summary).toMatchObject({ accepted: 1, discarded: 1 });
    const row = db.prepare('SELECT status, errors_json FROM import_row WHERE row_number = 2').get() as any;
    expect(row.status).toBe('rejected');
    expect(row.errors_json).toMatch(/discarded by you/);

    const off = await setup(['scan'], null);
    expect(getDraftView(off.db, off.id).rows[0]!.issues[0]!.message).toMatch(/no AI reader is set up/);
  });

  it('a page whose county is not a real county must be fixed before OK', async () => {
    const { db, id } = await setup([{ ...FAKE[0]!, county: 'ST JOSEP' }]);
    const v = getDraftView(db, id);
    expect(v.rows[0]!.review).toBe('needs_review');
    expect(v.rows[0]!.issues[0]!.message).toMatch(/isn't a county in IN/);
    expect(() => reviewRow(db, id, 1, { action: 'ok' })).toThrow(/Fill in first/);
    expect(reviewRow(db, id, 1, { action: 'ok', edits: { county: 'St Joseph' } }).review).toBe('ok');
  });

  it('keeps the draft through a restart and carries on reading; delete removes it and its file', async () => {
    const { c, db } = tempDb();
    const bytes = Buffer.from(await makeLeadPdf([FAKE[0]!, 'scan']));
    const { id } = createPdfDraft(db, c.importsDir, { fileName: 'a.pdf', bytes });
    // "Restart": a new worker finds the unfinished draft.
    const worker = new DraftWorker(db, Secrets.inDataDir(c.dataDir));
    worker.readerOverride = fakeReader();
    worker.resumeAll();
    await new Promise((r) => setTimeout(r, 50));
    while (worker.isRunning(id)) await new Promise((r) => setTimeout(r, 20));
    expect(getDraftView(db, id).status).toBe('review');
    const file = (db.prepare('SELECT file_path FROM import_draft WHERE id = ?').get(id) as any).file_path;
    expect(fs.existsSync(file)).toBe(true);
    deleteDraft(db, id);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => getDraftView(db, id)).toThrow(/not found/);
  });
});

describe('spreadsheet drafts and the Status column', () => {
  const headers = ['Status', 'Lead ID', 'Name', 'Phone', 'Address', 'City', 'Zip'];
  const row = (n: number, cells: string[]) => ({ rowNumber: n, cells: Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])) });
  const sheet: ParsedSheet = {
    name: 'Leads',
    headerRow: 1,
    headers,
    rows: [
      row(2, ['dialed', '900000011', 'Pat One', '(574) 555-0201', '1 A St', 'South Bend', '46619']),
      row(3, ['sold', '900000012', 'Pat Two', '(574) 555-0202', '2 A St', 'South Bend', '46619']),
      row(4, ['appt set', '900000013', 'Pat Three', '(574) 555-0203', '3 A St', 'South Bend', '46619']),
      row(5, ['reschedule', '900000014', 'Pat Four', '(574) 555-0204', '4 A St', 'Elkhart', '46514']),
      row(6, ['picked up', '', '', '', '', '', '']), // blanked out: taken off the call list
      row(7, ['', '900000016', 'Pat Six', '', '6 A St', 'Elkhart', '46514']), // phone missing: needs a look
    ],
  } as ParsedSheet;
  const mapping = { status: 'Status', source_lead_id: 'Lead ID', full_name: 'Name', phone: 'Phone', address: 'Address', city: 'City', zip: 'Zip' };

  it('discards blanked-out rows, asks about incomplete ones, and turns statuses into undated history', () => {
    const { c, db } = tempDb();
    const { id } = createSheetDraft(db, c.importsDir, { fileName: 'leads.xlsx', sha256: 'abc', bytes: Buffer.from('x'), fileModified: '2026-09-30T18:00:00.000Z' }, sheet, mapping);
    const v = getDraftView(db, id);
    expect(v.rows.map((r) => r.review)).toEqual(['auto', 'auto', 'auto', 'auto', 'discarded', 'needs_review']);
    expect(v.rows[4]!.notes).toMatch(/Only a status was left/);
    expect(v.rows[0]!.raw).toMatchObject({ Name: 'Pat One' }); // the original cells, for the review window
    reviewRow(db, id, 7, { action: 'ok', edits: { phone: '574-555-0206' } });
    commitDraft(db, c.importsDir, id, { name: 'Sept sheet' });

    const calls = db.prepare('SELECT history_source, time_known, requested_at FROM call').all() as any[];
    expect(calls).toHaveLength(4);
    expect(calls.every((x) => x.history_source === 'sheet' && x.time_known === 0 && x.requested_at === '2026-09-30T18:00:00.000Z')).toBe(true);
    const st = Object.fromEntries(
      (db.prepare('SELECT l.first_name || l.last_name n, s.status, s.next_due_at, s.attempts_total FROM lead l JOIN lead_state s ON s.lead_id = l.id').all() as any[]).map((r) => [r.n, r]),
    );
    expect(st.PatOne).toMatchObject({ status: 'retry', next_due_at: null, attempts_total: 1 }); // not held back by the retry gap
    expect(st.PatTwo).toMatchObject({ status: 'appointment_set', next_due_at: null }); // an old "sold" counts as booked
    expect(st.PatThree).toMatchObject({ status: 'appointment_set', next_due_at: null });
    expect(st.PatFour).toMatchObject({ status: 'callback', next_due_at: null });
    expect(st.PatSix).toMatchObject({ status: 'new' });

    const q = getQueue(db);
    expect(q.items.map((i) => [i.name, i.bucket, i.needs_time])).toEqual([
      ['Pat Four', 'callback_due', true],
      ['Pat Six', 'new', false],
      ['Pat One', 'retry', false],
    ]); // appointments set are out of the queue
    expect(db.prepare('SELECT count(*) n FROM appointment').get()).toEqual({ n: 0 }); // appointments live in Unitrust
  });

  it('the queue can be limited to counties, or to area codes linked to counties (never the lead\'s own area code)', () => {
    const { c, db } = tempDb();
    const { id } = createSheetDraft(db, c.importsDir, { fileName: 'l.xlsx', sha256: 'abd', bytes: Buffer.from('x') }, sheet, mapping);
    reviewRow(db, id, 7, { action: 'ok', edits: { phone: '312-555-0206' } }); // Elkhart lead with a Chicago number
    commitDraft(db, c.importsDir, id, { name: 's' });
    const names = (o: Parameters<typeof getQueue>[1]) => getQueue(db, o).items.map((i) => i.name).sort();
    expect(names({ counties: ['IN|ELKHART'] })).toEqual(['Pat Four', 'Pat Six']);
    db.prepare("INSERT INTO county_area_code VALUES ('IN|ELKHART', '574', 'x'), ('IN|ST JOSEPH', '574', 'x')").run();
    expect(names({ areaCodes: ['574'] })).toEqual(['Pat Four', 'Pat One', 'Pat Six']);
    expect(names({ areaCodes: ['312'] })).toEqual([]);
  });
});

describe('migration 003', () => {
  it('upgrades a database that already has appointments', () => {
    const c = tempConfig();
    const old = path.join(c.dataDir, 'old-migrations');
    fs.mkdirSync(old);
    const src = path.resolve('src/server/db/migrations');
    for (const f of ['001_init.sql', '002_outcome_codes.sql']) fs.copyFileSync(path.join(src, f), path.join(old, f));
    const d = new Database(c.dbFile);
    d.pragma('foreign_keys = ON');
    migrate(d, old);
    const now = new Date().toISOString();
    const b = uuidv7(), r = uuidv7(), l = uuidv7();
    d.prepare("INSERT INTO import_batch (id, name, source, file_name, file_sha256, imported_at, column_mapping_json) VALUES (?, 'b', 'x', 'f', 's', ?, '{}')").run(b, now);
    d.prepare("INSERT INTO import_row (id, batch_id, row_number, raw_json, row_fingerprint, status) VALUES (?, ?, 1, '{}', 'fp', 'accepted')").run(r, b);
    d.prepare("INSERT INTO lead (id, batch_id, import_row_id, first_name, phone_valid, coborrower_signal, created_at) VALUES (?, ?, ?, 'A', 0, 'unknown', ?)").run(l, b, r, now);
    d.prepare("INSERT INTO appointment (id, lead_id, scheduled_for, recorded_via, created_at) VALUES ('ap1', ?, ?, 'manual', ?)").run(l, now, now);
    migrate(d, src);
    expect(d.prepare('SELECT id, scheduled_for FROM appointment').all()).toEqual([{ id: 'ap1', scheduled_for: now }]);
    expect(d.pragma('foreign_key_check')).toEqual([]);
    d.close();
  });
});

describe('API keys', () => {
  it('are kept in a 0600 file and never returned', () => {
    const c = tempConfig();
    const s = Secrets.inDataDir(c.dataDir);
    s.set('anthropic_api_key', 'sk-ant-test-123');
    const f = path.join(c.dataDir, 'secrets.json');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(s.present()).toEqual({ anthropic_api_key: true, openai_api_key: false });
    s.set('anthropic_api_key', null);
    expect(s.get('anthropic_api_key')).toBeNull();
  });
});
