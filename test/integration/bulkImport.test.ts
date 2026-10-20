import { describe, it, expect } from 'vitest';
import { tempDb, sampleCsv, SAMPLE_ROWS, SAMPLE_HEADERS } from '../helpers.js';
import { makeLeadPdf, FAKE } from '../pdfFixtures.js';
import { DraftWorker, listDrafts, getDraftView, reviewRow, commitDraft } from '../../src/server/domain/drafts.js';
import { BulkImporter } from '../../src/server/domain/bulkImport.js';
import { Secrets } from '../../src/server/ai/settings.js';
import type { PageReader } from '../../src/server/ai/readers.js';
import { getCallList } from '../../src/server/domain/callList.js';

const HEADERS = ['Name', 'Phone', 'Address', 'City', 'State', 'Zip', 'County'];

/** n complete leads with phone numbers that don't repeat across calls with different offsets. */
function leadRows(n: number, offset = 0): string[][] {
  const rows: string[][] = [];
  for (let k = 0; k < n; k++) {
    const i = k + offset;
    const exch = 200 + (i % 700);
    const line = String(Math.floor(i / 700) % 10000).padStart(4, '0');
    rows.push([`Person${i} Tester`, `(317) ${exch}-${line}`, `${100 + (i % 9000)} Main St`, 'Indianapolis', 'IN', '46204', 'Marion']);
  }
  return rows;
}

const csv = (rows: (string | number)[][], headers = HEADERS) => sampleCsv(rows, headers);

function setup(reader: PageReader | null = null) {
  const { c, db } = tempDb();
  const worker = new DraftWorker(db, Secrets.inDataDir(c.dataDir));
  worker.readerOverride = reader;
  const bulk = new BulkImporter(db, c.importsDir, worker);
  return { c, db, worker, bulk };
}

const scanReader: PageReader = {
  name: 'ai:fake:test',
  async read() {
    return {
      extractor: 'ai:fake:test',
      cost_usd: 0,
      answer: {
        is_lead: true, layout: 'mailer_card',
        fields: {
          full_name: 'Casey Cardholder', coborrower: null, age: null, lender: 'HALLMARK', loan_amount: '$147,184', address: '2505 Sample Dr',
          city: 'Fort Wayne', state: 'IN', zip: '46809', county: null, source_lead_id: null, callin_date: null, phone: '260-555-0186',
          alt_phone: null, called_from: null,
        },
        uncertain: [], notes: null,
      },
    } as any;
  },
};

describe('bulk import', () => {
  it('imports many spreadsheets in one go, skips repeats, and reports what happened to each file', async () => {
    const { db, bulk } = setup();
    const { id } = bulk.create({ lead_type: 'D', add_to_call_list: true });
    const a = (await bulk.addFile(id, { fileName: 'week1.csv', relPath: 'leads/week1.csv', bytes: csv(leadRows(50)) }))[0]!;
    expect(a).toMatchObject({ state: 'imported', summary: { leads: 50, repeats: 0, to_check: 0, added_to_call_list: 50 } });
    // Overlaps the first file by 10 leads.
    const b = (await bulk.addFile(id, { fileName: 'week2.csv', bytes: csv(leadRows(30, 40)) }))[0]!;
    expect(b).toMatchObject({ state: 'imported', summary: { leads: 20, repeats: 10 } });
    // The same file again, from another folder.
    const c = (await bulk.addFile(id, { fileName: 'copy of week1.csv', bytes: csv(leadRows(50)) }))[0]!;
    expect(c).toMatchObject({ state: 'nothing_new' });
    expect(c.message).toMatch(/imported before/);
    // Every lead already in.
    const d = (await bulk.addFile(id, { fileName: 'again.csv', bytes: csv(leadRows(20, 5)) }))[0]!;
    expect(d).toMatchObject({ state: 'nothing_new', summary: { repeats: 20, leads: 0 } });
    const e = (await bulk.addFile(id, { fileName: 'notes.docx', bytes: Buffer.from('PK...') }))[0]!;
    expect(e).toMatchObject({ state: 'failed' });
    const f = (await bulk.addFile(id, { fileName: 'odd.csv', bytes: csv([['x', 'y']], ['Foo', 'Bar']) }))[0]!;
    expect(f).toMatchObject({ state: 'needs_columns' });

    const s = bulk.status(id);
    expect(s.totals).toMatchObject({
      files: 6, imported_files: 2, nothing_new_files: 2, failed_files: 1, needs_columns_files: 1, waiting: 0, leads: 70, repeats: 30,
      added_to_call_list: 70,
    });
    expect((db.prepare('SELECT COUNT(*) n FROM lead').get() as { n: number }).n).toBe(70);
    expect((db.prepare("SELECT COUNT(*) n FROM import_batch WHERE name IN ('week1','week2')").get() as { n: number }).n).toBe(2);
    expect(getCallList(db).length).toBe(70);
    expect(listDrafts(db)).toEqual([]);
  });

  it('imports the complete leads now and puts the ones that need a look aside', async () => {
    const { db, c, bulk } = setup();
    const { id } = bulk.create({ lead_type: 'D' });
    // Sample rows: two have no phone or a bad one, so they need a look.
    const r = (await bulk.addFile(id, { fileName: 'mixed.csv', bytes: sampleCsv(SAMPLE_ROWS, SAMPLE_HEADERS) }))[0]!;
    expect(r.state).toBe('needs_review');
    expect(r.summary.leads).toBeGreaterThan(0);
    expect(r.summary.to_check).toBeGreaterThan(0);
    const leadsNow = (db.prepare('SELECT COUNT(*) n FROM lead').get() as { n: number }).n;
    expect(leadsNow).toBe(r.summary.leads);
    // The rest wait in "Imports to finish"; finishing them there updates the bulk import.
    const drafts = listDrafts(db);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.id).toBe(r.draft_id);
    const v = getDraftView(db, r.draft_id!);
    for (const row of v.rows) reviewRow(db, v.id, row.row_number, { action: 'discard' });
    // Nothing new left to import in that part, so delete it.
    await import('../../src/server/domain/drafts.js').then((m) => m.deleteDraft(db, v.id));
    const s = bulk.status(id);
    expect(s.files[0]).toMatchObject({ state: 'imported', summary: { to_check: 0, leads: r.summary.leads } });
    expect(c).toBeTruthy();
  });

  it('can hold a whole file back until it is checked instead', async () => {
    const { db, c, bulk } = setup();
    const { id } = bulk.create({ import_ready_now: false });
    const r = (await bulk.addFile(id, { fileName: 'mixed.csv', bytes: sampleCsv(SAMPLE_ROWS, SAMPLE_HEADERS) }))[0]!;
    expect(r).toMatchObject({ state: 'needs_review', summary: { leads: 0 } });
    expect((db.prepare('SELECT COUNT(*) n FROM lead').get() as { n: number }).n).toBe(0);
    const v = getDraftView(db, r.draft_id!);
    for (const row of v.rows.filter((x) => x.review === 'needs_review')) reviewRow(db, v.id, row.row_number, { action: 'discard' });
    const done = commitDraft(db, c.importsDir, v.id, { name: 'mixed' });
    const s = bulk.status(id);
    expect(s.files[0]).toMatchObject({ state: 'imported', batch_id: done.batchId, summary: { leads: done.summary.accepted } });
  });

  it('reads PDFs a few at a time in the background, then imports them', async () => {
    const { db, bulk } = setup(scanReader);
    bulk.maxReading = 1;
    const { id } = bulk.create({ lead_type: 'D' });
    const typed = Buffer.from(await makeLeadPdf([FAKE[0]!, FAKE[1]!]));
    const withScan = Buffer.from(await makeLeadPdf([{ ...FAKE[0]!, id: '900000009', name: ['SAM', 'OTHER'], phone: '(574) 555-0199', calledFrom: '(574) 555-0199' }, 'scan']));
    const one = (await bulk.addFile(id, { fileName: 'IN_574_1-2.pdf', bytes: typed }))[0]!;
    const two = (await bulk.addFile(id, { fileName: 'IN_574_3-4.pdf', bytes: withScan }))[0]!;
    expect(['queued', 'reading']).toContain(one.state);
    expect(two.state).toBe('queued');
    await bulk.whenIdle();
    const s = bulk.status(id);
    expect(s.files[0]).toMatchObject({ state: 'imported', summary: { leads: 2 } });
    // The scan always gets a look; the typed page went in.
    expect(s.files[1]).toMatchObject({ state: 'needs_review', summary: { leads: 1, to_check: 1 } });
    expect(s.totals).toMatchObject({ leads: 3, to_check: 1, waiting: 0 });
    expect((db.prepare('SELECT COUNT(*) n FROM lead').get() as { n: number }).n).toBe(3);
  });

  it('picks up PDFs that were still being read after a restart', async () => {
    const { db, c, bulk } = setup();
    bulk.maxReading = 0; // nothing starts reading yet, like the app stopping right after the upload
    const { id } = bulk.create({});
    await bulk.addFile(id, { fileName: 'IN_574_1-2.pdf', bytes: Buffer.from(await makeLeadPdf([FAKE[0]!, FAKE[1]!])) });
    expect(bulk.status(id).files[0]!.state).toBe('queued');
    // A fresh start: the draft worker leaves bulk files to the bulk importer.
    const worker = new DraftWorker(db, Secrets.inDataDir(c.dataDir));
    worker.readerOverride = null;
    worker.resumeAll();
    expect(worker.isRunning(bulk.status(id).files[0]!.draft_id!)).toBe(false);
    const again = new BulkImporter(db, c.importsDir, worker);
    again.resume();
    await again.whenIdle();
    expect(again.status(id).files[0]).toMatchObject({ state: 'imported', summary: { leads: 2 } });
  });

  it('imports a big spreadsheet in parts, one batch each, and counts repeats across the parts', async () => {
    const { db, bulk } = setup();
    bulk.partRows = 40;
    const { id } = bulk.create({});
    // 100 rows, the last 10 repeating the first 10.
    const rows = [...leadRows(90), ...leadRows(10)];
    const parts = await bulk.addFile(id, { fileName: 'export.csv', bytes: csv(rows) });
    expect(parts.map((p) => [p.part, p.state, p.summary.leads, p.summary.repeats])).toEqual([
      ['1 of 3', 'imported', 40, 0], ['2 of 3', 'imported', 40, 0], ['3 of 3', 'imported', 10, 10],
    ]);
    expect((db.prepare("SELECT name FROM import_batch ORDER BY name").all() as { name: string }[]).map((b) => b.name)).toEqual([
      'export (part 1 of 3)', 'export (part 2 of 3)', 'export (part 3 of 3)',
    ]);
    expect(bulk.status(id).totals).toMatchObject({ files: 3, leads: 90, repeats: 10 });
    // The same file again is skipped as a whole.
    const again = await bulk.addFile(id, { fileName: 'export.csv', bytes: csv(rows) });
    expect(again).toHaveLength(1);
    expect(again[0]!.state).toBe('nothing_new');
  });

  it('handles large files quickly', async () => {
    // 10,000 leads in two files. Bigger runs hogged the Windows CI machine for a minute and a half,
    // which made other test files time out and stopped the release from being published.
    const { db, bulk } = setup();
    const { id } = bulk.create({ lead_type: 'D' });
    const started = Date.now();
    for (let f = 0; f < 2; f++) {
      const r = (await bulk.addFile(id, { fileName: `big${f}.csv`, bytes: csv(leadRows(5_000, f * 5_000)) }))[0]!;
      expect(r).toMatchObject({ state: 'imported', summary: { leads: 5_000 } });
    }
    const ms = Date.now() - started;
    expect((db.prepare('SELECT COUNT(*) n FROM lead').get() as { n: number }).n).toBe(10_000);
    // Generous: a couple of seconds on a normal computer, still well under this on a slow test machine.
    expect(ms).toBeLessThan(45_000);
    console.log(`bulk import: 10,000 leads in ${(ms / 1000).toFixed(1)}s`);
  }, 60_000);
});

describe('bulk import over HTTP', () => {
  it('creates a run, takes files bigger than the usual request limit, and reports them', async () => {
    const { buildApp } = await import('../../src/server/http/app.js');
    const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
    const headers = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };
    const { db, c } = tempDb();
    const app = await buildApp({ db, config: c, token: TOKEN });
    const created = await app.inject({ method: 'POST', url: '/api/bulk-imports', headers, payload: { lead_type: 'D' } });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    const big = csv(leadRows(20_000)); // about 1.3 MB, over the 1 MB default
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const up = await app.inject({
      method: 'POST', url: `/api/bulk-imports/${id}/files`, payload: big,
      headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('Week 3.csv'), 'x-file-path': encodeURIComponent('orders/Week 3.csv') },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().map((f: any) => [f.rel_path, f.part, f.state])).toEqual([
      ['orders/Week 3.csv', '1 of 2', 'imported'], ['orders/Week 3.csv', '2 of 2', 'imported'],
    ]);
    const s = await app.inject({ url: `/api/bulk-imports/${id}`, headers });
    expect(s.json().totals).toMatchObject({ files: 2, leads: 20_000 });
    const list = await app.inject({ url: '/api/bulk-imports', headers });
    expect(list.json()).toHaveLength(1);
    // The Leads page can show just this run's leads, and what it left out downloads as one CSV.
    await app.inject({ method: 'POST', url: `/api/bulk-imports/${id}/files`, payload: csv(leadRows(6, 19_999)), headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': 'again.csv' } });
    const other = (await app.inject({ method: 'POST', url: '/api/bulk-imports', headers, payload: {} })).json().id;
    await app.inject({ method: 'POST', url: `/api/bulk-imports/${other}/files`, payload: csv(leadRows(3, 50_000)), headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': 'other.csv' } });
    const leads = await app.inject({ url: `/api/leads?bulk_id=${id}`, headers });
    expect(leads.json().total).toBe(20_005);
    expect((await app.inject({ url: `/api/leads?bulk_id=${other}`, headers })).json().total).toBe(3);
    expect((await app.inject({ url: '/api/leads', headers })).json().total).toBe(20_008);
    const problems = await app.inject({ url: `/api/bulk-imports/${id}/problems.csv`, headers });
    expect(problems.statusCode).toBe(200);
    const lines = problems.body.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1 + 1);
    expect(lines[0]).toMatch(/^file,batch,row_number,status,problems/);
    expect(lines[1]).toMatch(/^again\.csv,again,\d+,already_imported,/);
    const missing = await app.inject({ url: '/api/bulk-imports/nope', headers });
    expect(missing.statusCode).toBe(404);
  }, 60_000);
});
