import { describe, it, expect } from 'vitest';
import { tempDb } from '../helpers.js';
import { makeLeadPdf } from '../pdfFixtures.js';
import { DraftWorker } from '../../src/server/domain/drafts.js';
import { BulkImporter } from '../../src/server/domain/bulkImport.js';
import { Secrets } from '../../src/server/ai/settings.js';
import type { PageReader } from '../../src/server/ai/readers.js';

describe('stopping while imports are being read', () => {
  it('closes the database under a running read without a stray error, and the read resumes on the next start', async () => {
    const { c, db } = tempDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const reading = new Promise<void>((r) => (started = r));
    const slowReader: PageReader = {
      name: 'ai:fake:test',
      async read() {
        started();
        await gate;
        throw new Error('the reader was interrupted');
      },
    };
    const worker = new DraftWorker(db, Secrets.inDataDir(c.dataDir));
    worker.readerOverride = slowReader;
    const bulk = new BulkImporter(db, c.importsDir, worker);
    const { id } = bulk.create({});
    await bulk.addFile(id, { fileName: 'scan.pdf', bytes: Buffer.from(await makeLeadPdf(['scan'])) });
    await reading;

    // What server.stop() does: stop the workers, then close the database.
    worker.stop();
    bulk.stop();
    db.close();
    release();
    await expect(bulk.whenIdle()).resolves.toBeUndefined();

    // The draft was left as "reading", so the next start picks it up again.
    const { openDatabase } = await import('../../src/server/db/connection.js');
    const again = openDatabase(c.dbFile);
    expect((again.prepare('SELECT status FROM import_draft').get() as { status: string }).status).toBe('reading');
    again.close();
  });
});
