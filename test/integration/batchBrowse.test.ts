import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { browseImports } from '../../src/server/domain/importHistory.js';
import { buildReport, drill } from '../../src/server/domain/reports.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

// The batch lists: bulk imports as one line, search and filters, a page at a time.

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };
const HEADERS = ['Lead Name', 'Phone', 'City', 'State', 'Zip', 'County'];

let db: DB;
let app: FastifyInstance;
let n = 0;

/** Imports a one-lead batch, `daysAgo` days back. Synthetic leads only. */
async function batch(name: string, daysAgo: number, type: string | null = 'D') {
  n++;
  const parsed = await parseSpreadsheet(sampleCsv([[`Lead ${name}`, `(260) 555-${String(1000 + n)}`, 'Fort Wayne', 'IN', '46802', 'Allen']], HEADERS), `${name}.csv`);
  const sheet = parsed.sheets[0]!;
  const id = commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name }).batchId;
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  db.prepare('UPDATE import_batch SET imported_at = ? WHERE id = ?').run(at, id);
  db.prepare('UPDATE lead SET lead_type = ? WHERE batch_id = ?').run(type, id);
  return id;
}

/** Records batches as the files of one bulk import. */
function bulk(batchIds: string[], daysAgo: number) {
  const id = uuidv7();
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  db.prepare("INSERT INTO import_bulk (id, settings_json, created_at, updated_at) VALUES (?, '{}', ?, ?)").run(id, at, at);
  batchIds.forEach((b, i) => {
    db.prepare(
      `INSERT INTO import_bulk_file (bulk_id, seq, file_name, state, batch_id, summary_json, created_at, updated_at)
       VALUES (?, ?, ?, 'imported', ?, ?, ?, ?)`,
    ).run(id, i + 1, `f${i}.csv`, b, JSON.stringify({ leads: 1, repeats: 0, not_imported: 0, to_check: 0, added_to_call_list: 0, batches: [b] }), at, at);
  });
  return id;
}

let ids: Record<string, string>;
let bulkId: string;

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  n = 0;
  ids = {
    old: await batch('Old Ohio', 200, 'C'),
    a: await batch('Allen part 1', 3),
    b: await batch('Allen part 2', 3),
    c: await batch('Marion mail', 3, 'DM-A'),
    recent: await batch('Fresh call-ins', 1, 'CI-A'),
  };
  bulkId = bulk([ids.a!, ids.b!, ids.c!], 3);
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('batch lists', () => {
  it('shows each bulk import as one line, newest first, with totals', () => {
    const r = browseImports(db, {});
    expect(r.total).toBe(3);
    expect(r.groups.map((g) => g.kind)).toEqual(['batch', 'bulk', 'batch']);
    const g = r.groups[1]!;
    expect(g).toMatchObject({ id: bulkId, batches_total: 3, totals: { leads: 3, left: 3, lead_types: ['D', 'DM-A'] }, bulk: { files: 3, reading: 0, to_check: 0 } });
    expect(g.batches.map((b) => b.name).sort()).toEqual(['Allen part 1', 'Allen part 2', 'Marion mail']);
  });

  it('searches, filters and pages', () => {
    // Within a bulk import, only the matching files show.
    const s = browseImports(db, { search: 'marion' });
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ kind: 'bulk', batches_total: 3 });
    expect(s.groups[0]!.batches.map((b) => b.name)).toEqual(['Marion mail']);
    // By lead type code, too.
    expect(browseImports(db, { search: 'ci-a' }).groups.map((g) => g.batches[0]!.name)).toEqual(['Fresh call-ins']);
    expect(browseImports(db, { lead_type: 'C' }).groups.map((g) => g.batches[0]!.name)).toEqual(['Old Ohio']);
    expect(browseImports(db, { days: 30 }).total).toBe(2);
    // A lead that was reached has nothing left to call.
    const lead = (db.prepare('SELECT id FROM lead WHERE batch_id = ?').get(ids.recent) as { id: string }).id;
    logManualCall(db, { lead_id: lead, idempotency_key: uuidv7(), outcome_code: 'appointment', occurred_at: new Date().toISOString() } as any);
    expect(browseImports(db, { left: true }).groups.map((g) => g.kind)).toEqual(['bulk', 'batch']);
    // Paging.
    expect(browseImports(db, { limit: 2 }).groups).toHaveLength(2);
    expect(browseImports(db, { limit: 2, offset: 2 }).groups.map((g) => g.batches[0]!.name)).toEqual(['Old Ohio']);
    // The line holding a batch or bulk import, for the picker's label.
    expect(browseImports(db, { key: ids.b }).groups.map((g) => g.id)).toEqual([bulkId]);
    expect(browseImports(db, { key: `bulk:${bulkId}` }).groups).toHaveLength(1);
  });

  it('answers over HTTP', async () => {
    const r = (await app.inject({ url: '/api/imports/browse?search=allen&days=30&lead_type=D&left=1&limit=10', headers: auth })).json();
    expect(r.total).toBe(1);
    expect(r.groups[0].batches).toHaveLength(2);
    expect((await app.inject({ url: '/api/imports/browse?lead_type=none', headers: auth })).json().total).toBe(0);
    expect((await app.inject({ url: '/api/imports/browse?limit=0', headers: auth })).statusCode).toBe(400);
  });

  it('Reports by batch knows each batch\'s bulk import, and opens a whole bulk import\'s leads', () => {
    const f = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(), tz: 'America/Indiana/Indianapolis' };
    const r = buildReport(db, f);
    expect(r.by_batch.filter((b) => b.bulk_id === bulkId)).toHaveLength(3);
    expect(r.by_batch.find((b) => b.key === ids.old)).toMatchObject({ bulk_id: null, type_codes: ['C'], left: 1 });
    expect(drill(db, f, { section: 'by_batch', key: `bulk:${bulkId}`, metric: 'leads' }).rows).toHaveLength(3);
  });
});
