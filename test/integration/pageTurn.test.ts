import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import { tempDb } from '../helpers.js';
import { makeLeadPdf, FAKE } from '../pdfFixtures.js';
import { readPdfText, pdfTextTurns } from '../../src/server/domain/pdfReader.js';
import { turnPdfPages, batchPdf } from '../../src/server/domain/pageTurn.js';
import { fixImportedPageTurns } from '../../src/server/domain/pageTurnFix.js';
import { createPdfDraft, DraftWorker, getDraftView, reviewRow, commitDraft } from '../../src/server/domain/drafts.js';
import { Secrets } from '../../src/server/ai/settings.js';
import { AiError, type PageReader } from '../../src/server/ai/readers.js';

/** A reader that says how far each scan has to be turned (in the order it is asked). */
const turningReader = (turns: ('0' | '90' | '180' | '270')[], calls: number[] = []): PageReader => ({
  name: 'ai:fake:turn',
  async read() {
    calls.push(1);
    return {
      extractor: 'ai:fake:turn',
      cost_usd: 0,
      answer: {
        is_lead: true, layout: 'mailer_card', turn: turns[calls.length - 1] ?? '0',
        fields: {
          full_name: 'Casey Cardholder', coborrower: null, age: null, lender: 'HALLMARK', loan_amount: '$147,184', address: '2505 Sample Dr',
          city: 'Fort Wayne', state: 'IN', zip: '46809', county: null, source_lead_id: null, callin_date: null, phone: '260-555-0186',
          alt_phone: null, called_from: null,
        },
        uncertain: [], notes: null,
      },
    };
  },
});

async function rotations(file: string) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  return doc.getPages().map((p) => ((p.getRotation().angle % 360) + 360) % 360);
}

/** Turns pages of a PDF, as a scanner or a lead vendor might have sent them. */
async function skew(bytes: Uint8Array, turns: Record<number, number>) {
  const doc = await PDFDocument.load(bytes);
  for (const [p, t] of Object.entries(turns)) {
    const page = doc.getPage(Number(p) - 1);
    page.setRotation(degrees((page.getRotation().angle + t) % 360));
  }
  return doc.save();
}

describe('turning lead pages upright', () => {
  it('works out from the text how far a typed page has to turn, and turning it makes the text read upright', async () => {
    // FAKE[1] is printed sideways (text runs top to bottom); the second copy of FAKE[0] is upside down.
    const pdf = await skew(await makeLeadPdf([FAKE[0]!, FAKE[1]!, FAKE[0]!, 'scan']), { 3: 180 });
    const pages = await readPdfText(pdf);
    expect(pages.map((p) => p.turn)).toEqual([0, 270, 180, null]);
    // Still read correctly whichever way up.
    expect(pages[2]!.fields.full_name).toBe('ALEX SAMPLEPERSON');

    const { c } = tempDb();
    const file = path.join(c.importsDir, 'x.pdf');
    fs.writeFileSync(file, pdf);
    expect(await turnPdfPages(file, new Map([[2, 270], [3, 180]]))).toBe(2);
    expect(await pdfTextTurns(new Uint8Array(fs.readFileSync(file)))).toEqual([0, 0, 0, null]);
    expect(await rotations(file)).toEqual([0, 0, 0, 0]);
    // Nothing to turn: the file isn't rewritten.
    const before = fs.statSync(file).mtimeMs;
    expect(await turnPdfPages(file, new Map([[1, 0], [2, 360]]))).toBe(0);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('an import turns sideways typed pages and scans the AI says are turned, so review and the lead page show them upright', async () => {
    const { c, db } = tempDb();
    const worker = new DraftWorker(db, Secrets.inDataDir(c.dataDir));
    worker.readerOverride = turningReader(['90', '0']);
    const bytes = Buffer.from(await makeLeadPdf([FAKE[0]!, FAKE[1]!, 'scan', 'scan']));
    const { id } = createPdfDraft(db, c.importsDir, { fileName: 'IN_574_1-4.pdf', bytes });
    await worker.run(id);
    const v = getDraftView(db, id);
    expect(v.status).toBe('review');
    const draftFile = (db.prepare('SELECT file_path FROM import_draft WHERE id = ?').get(id) as { file_path: string }).file_path;
    // Page 2 was printed with Rotate 90 and is now 0; page 3 (scan) turned a quarter clockwise; page 4 left alone.
    expect(await rotations(draftFile)).toEqual([0, 0, 90, 0]);
    // The file's fingerprint is still the one you uploaded, so importing it again is still caught.
    expect((db.prepare('SELECT file_sha256 FROM import_draft WHERE id = ?').get(id) as any).file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.rows.every((r) => !('turn' in r))).toBe(true);
    for (const r of v.rows.filter((r) => r.review === 'needs_review')) reviewRow(db, id, r.row_number, { action: 'discard' });
    const res = commitDraft(db, c.importsDir, id, { name: 'Oct' });
    expect(await rotations(batchPdf(c.importsDir, res.batchId)!)).toEqual([0, 0, 90, 0]);
  });

  it('one-time fix: turns pages of leads imported before, once, and tries scans again later if the AI fails', async () => {
    const { c, db } = tempDb();
    const worker = new DraftWorker(db, Secrets.inDataDir(c.dataDir));
    worker.readerOverride = turningReader(['0', '0']);
    const bytes = Buffer.from(await makeLeadPdf([FAKE[0]!, FAKE[1]!, 'scan']));
    const { id } = createPdfDraft(db, c.importsDir, { fileName: 'old.pdf', bytes });
    await worker.run(id);
    reviewRow(db, id, 3, { action: 'ok' });
    const { batchId } = commitDraft(db, c.importsDir, id, { name: 'Old' });
    const file = batchPdf(c.importsDir, batchId)!;
    // As an older version left it: the typed page sideways, the scan upside down.
    fs.writeFileSync(file, await skew(new Uint8Array(fs.readFileSync(file)), { 2: 90, 3: 180 }));
    const skewed = await rotations(file);
    expect(skewed).toEqual([0, 90, 180]);

    // The AI is down: the typed page is fixed now, the scan waits.
    const down: PageReader = { name: 'ai:down', read: async () => { throw new AiError('offline'); } };
    let r = await fixImportedPageTurns(db, c.importsDir, down);
    expect(r).toMatchObject({ pages_turned: 1, left_for_later: 1 });
    expect(await rotations(file)).toEqual([0, 0, 180]);

    // Next start: the AI says the scan is upside down.
    const calls: number[] = [];
    r = await fixImportedPageTurns(db, c.importsDir, turningReader(['180'], calls));
    expect(r).toMatchObject({ pages_turned: 1, left_for_later: 0 });
    expect(calls.length).toBe(1);
    expect(await rotations(file)).toEqual([0, 0, 0]);

    // Done: later starts leave it alone and don't ask the AI again.
    r = await fixImportedPageTurns(db, c.importsDir, turningReader(['90'], calls));
    expect(r).toMatchObject({ batches: 0, pages_turned: 0 });
    expect(calls.length).toBe(1);
  });
});
