import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { addToCallList, getCallList } from '../../src/server/domain/callList.js';
import { loadCallingSettings, saveCallingSettings } from '../../src/server/domain/callingSettings.js';
import { saveStatuses } from '../../src/server/domain/statuses.js';
import { createCustomField, deleteCustomField } from '../../src/server/domain/customFields.js';
import { tagLead } from '../../src/server/domain/tags.js';
import { STARTER_ORDER, yourOrder, type SortStep } from '../../src/shared/listOrder.js';
import { buildApp } from '../../src/server/http/app.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const write = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const setOrder = (list_order: SortStep[]) => saveCallingSettings(db, { ...loadCallingSettings(db), list_order });
const names = () => {
  const s = loadCallingSettings(db);
  return yourOrder(getCallList(db), s.list_order, {}).map((i) => i.name.split(' ')[0]);
};

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  db.prepare('DELETE FROM call_list_item').run();
  addToCallList(db, ['Jane', 'Robert', 'Ann', 'John'].map(lead));
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('your call list order', () => {
  it('starts with put-back leads first, then the best time to call', () => {
    expect(loadCallingSettings(db).list_order).toEqual(STARTER_ORDER);
    expect(getCallList(db).every((i) => i.sort_keys.length === 2 && i.sort_keys[0] === 0 && i.sort_keys[1] === null)).toBe(true);
  });

  it('a yes/no puts its leads first, a number the highest (or lowest) first, ties stay as on the list', () => {
    setOrder([{ by: 'formula', formula: 'has("Hot")', lowest_first: false }]);
    tagLead(db, lead('Ann'), 'Hot');
    expect(names()).toEqual(['Ann', 'Jane', 'Robert', 'John']);

    setOrder([{ by: 'formula', formula: 'age', lowest_first: false }]);
    expect(names()).toEqual(['Robert', 'John', 'Jane', 'Ann']);
    setOrder([{ by: 'formula', formula: 'age', lowest_first: true }]);
    expect(names()).toEqual(['Ann', 'Jane', 'John', 'Robert']);

    // The first step that tells them apart decides.
    setOrder([{ by: 'formula', formula: 'has("Hot")', lowest_first: false }, { by: 'formula', formula: 'age', lowest_first: false }]);
    expect(names()).toEqual(['Ann', 'Robert', 'John', 'Jane']);
  });

  it('statuses work in a step', async () => {
    saveStatuses(db, [{ id: 's1', name: 'Old', condition: 'age >= 60', color: 'blue', tab: false }]);
    setOrder([{ by: 'formula', formula: 'status("Old")', lowest_first: false }]);
    expect(names()[0]).toBe('Robert');
  });

  it('a step with a mistake is refused, and one whose field has gone since sorts nothing', async () => {
    const bad = await app.inject({
      method: 'PUT', url: '/api/settings/calling', headers: write,
      payload: { ...loadCallingSettings(db), list_order: [{ by: 'best_time' }, { by: 'formula', formula: 'state', lowest_first: false }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Call list order, step 2: a sort step has to be a number/);

    const f = createCustomField(db, { label: 'Score', type: 'number' });
    setOrder([{ by: 'formula', formula: 'field("Score")', lowest_first: false }]);
    deleteCustomField(db, f.id);
    expect(getCallList(db).every((i) => i.sort_keys[0] === null)).toBe(true);
    expect(names()).toEqual(['Jane', 'Robert', 'Ann', 'John']);
  });

  it('the call list sends your steps for the screen', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/call-list', headers: write });
    expect(r.json().list_order).toEqual(STARTER_ORDER);
  });
});
