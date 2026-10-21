import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv, dueLeads } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { builtInAreaCodes, builtInStates, seedCountyAreaCodes } from '../../src/server/domain/areaCodes.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };

let db: DB;
let app: FastifyInstance;

// Synthetic leads in three counties. Two share the 614 area code's county (Franklin, OH);
// one lives in Franklin county but has a 937 phone, to prove the filter goes by county, not by phone.
const HEADERS = ['Lead Name', 'Phone', 'City', 'State', 'Zip', 'County'];
const ROWS = [
  ['Amy Franklin', '(614) 555-0101', 'Columbus', 'OH', '43215', 'Franklin'],
  ['Ben Franklin', '(937) 555-0102', 'Columbus', 'OH', '43215', 'Franklin'],
  ['Cal Montgomery', '(614) 555-0103', 'Dayton', 'OH', '45402', 'Montgomery'],
  ['Dee Allen', '(260) 555-0104', 'Fort Wayne', 'IN', '46802', 'Allen'],
];

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(ROWS, HEADERS), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

const names = (rows: any[]) => rows.map((r) => String(r.first_name ?? r.lead_name ?? r.name).split(' ')[0]).sort();

describe('built-in county area codes', () => {
  it('covers Indiana, Michigan and Ohio', () => {
    expect(builtInStates()).toEqual(expect.arrayContaining(['IN', 'MI', 'OH']));
    expect(builtInAreaCodes('IN|ALLEN')).toEqual(['260']);
    expect(builtInAreaCodes('OH|FRANKLIN')).toContain('614');
    expect(builtInAreaCodes('MI|WAYNE')).toContain('313');
    expect(builtInAreaCodes('TX|HARRIS')).toEqual([]);
  });

  it('links each county once, and leaves your own changes alone', () => {
    expect(seedCountyAreaCodes(db)).toBe(3);
    const codes = () => db.prepare("SELECT area_code FROM county_area_code WHERE county_key = 'IN|ALLEN'").all();
    expect(codes()).toEqual([{ area_code: '260' }]);
    db.prepare("DELETE FROM county_area_code WHERE county_key = 'IN|ALLEN'").run();
    expect(seedCountyAreaCodes(db)).toBe(0);
    expect(codes()).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action = 'built_in'").get()).toEqual({ n: 3 });
  });

  it('fills them in when the counties list loads', async () => {
    const r = (await app.inject({ url: '/api/counties', headers: auth })).json() as any[];
    const allen = r.find((c) => c.county_key === 'IN|ALLEN');
    expect(allen.area_codes).toEqual(['260']);
    expect(allen.built_in).toEqual(['260']);
    // The lead page carries its county's codes, so Calling can check the caller ID against them.
    const dee = (db.prepare("SELECT id FROM lead WHERE first_name = 'Dee'").get() as { id: string }).id;
    expect((await app.inject({ url: `/api/leads/${dee}`, headers: auth })).json().county_area_codes).toEqual(['260']);
  });
});

describe('area code filter goes by county, never by the lead\'s phone', () => {
  beforeEach(() => void seedCountyAreaCodes(db));

  it('leads ready to call', () => {
    expect(names(dueLeads(db, { areaCodes: ['614'] }))).toEqual(['Amy', 'Ben']);
    expect(names(dueLeads(db, { areaCodes: ['260'], counties: ['OH|MONTGOMERY'] }))).toEqual(['Cal', 'Dee']);
  });

  it('leads list and its search box', async () => {
    const get = async (q: string) => (await app.inject({ url: `/api/leads?${q}`, headers: auth })).json().rows;
    expect(names(await get('area_codes=614'))).toEqual(['Amy', 'Ben']);
    expect(names(await get('counties=IN%7CALLEN'))).toEqual(['Dee']);
    // A bare area code typed in search means the county's code.
    expect(names(await get('search=614'))).toEqual(['Amy', 'Ben']);
    // A longer number searches phones.
    expect(names(await get('search=555-0103'))).toEqual(['Cal']);
    expect(names(await get('search=montg'))).toEqual(['Cal']);
  });

  it('calls list and agenda', async () => {
    for (const r of db.prepare('SELECT id FROM lead').all() as { id: string }[]) {
      logManualCall(db, { lead_id: r.id, idempotency_key: uuidv7(), outcome_code: 'no_answer' });
    }
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const calls = (await app.inject({ url: `/api/calls?from=${from}&to=${to}&area_codes=614`, headers: auth })).json() as any[];
    expect(calls.map((c) => c.lead_name.split(' ')[0]).sort()).toEqual(['Amy', 'Ben']);
    expect(calls.every((c) => c.county === 'Franklin')).toBe(true);
    const soon = new Date(Date.now() + 1800_000).toISOString();
    for (const r of db.prepare("SELECT id FROM lead WHERE first_name IN ('Amy','Dee')").all() as { id: string }[]) {
      logManualCall(db, { lead_id: r.id, idempotency_key: uuidv7(), outcome_code: 'callback', callback_due_at: soon });
    }
    const agenda = (await app.inject({ url: `/api/agenda?from=${from}&to=${to}&area_codes=260`, headers: auth })).json();
    expect(names(agenda.callbacks)).toEqual(['Dee']);
  });
});
