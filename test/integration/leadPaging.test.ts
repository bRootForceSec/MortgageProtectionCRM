import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv, SAMPLE_HEADERS } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { listLeads } from '../../src/server/domain/leads.js';
import { toLeadFilter } from '../../src/server/domain/callList.js';
import { LeadQuery } from '../../src/shared/leadFilter.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  // 60 leads, each with its own phone.
  const rows = Array.from({ length: 60 }, (_, i) => [`Lead${String(i).padStart(2, '0')} Person`, `(614) 555-${String(1000 + i)}`, 'Chase', '100000', 50, '', '', '', 'OH', '', '', '', '', '', '', '']);
  const parsed = await parseSpreadsheet(sampleCsv(rows, SAMPLE_HEADERS), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('Leads paging', () => {
  it('pages through every lead, each once, and keeps the last page in range', () => {
    const all = toLeadFilter(LeadQuery.parse({}));
    const p1 = listLeads(db, all, { page: 1, per_page: 25 });
    const p2 = listLeads(db, all, { page: 2, per_page: 25 });
    const p3 = listLeads(db, all, { page: 3, per_page: 25 });
    expect([p1.total, p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([60, 25, 25, 10]);
    expect(new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id)).size).toBe(60);
    // Past the end gives the last page.
    expect(listLeads(db, all, { page: 9, per_page: 25 })).toMatchObject({ page: 3 });
    // Without paging: up to 500, as before.
    expect(listLeads(db, all)).toMatchObject({ page: 1, per_page: 500 });
    expect(listLeads(db, all).rows).toHaveLength(60);
  });

  it('the route takes page and per_page, and refuses a page size it does not offer', async () => {
    const r = await app.inject({ url: '/api/leads?page=2&per_page=50&search=Lead', headers: auth });
    expect(r.json()).toMatchObject({ total: 60, page: 2, per_page: 50 });
    expect(r.json().rows).toHaveLength(10);
    expect((await app.inject({ url: '/api/leads?per_page=7', headers: auth })).statusCode).toBe(400);
  });
});
