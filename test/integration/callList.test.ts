import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, changeOutcome, voidCall, addLeadAction } from '../../src/server/domain/calls.js';
import {
  addBatchToCallList, addMatchingToCallList, addToCallList, clearWorked, getCallList, moveToBottom, recentOutcomes, removeFromCallList,
  callListName, clearCallList, deleteSavedList, listSavedLists, loadSavedList,
} from '../../src/server/domain/callList.js';
import { buildApp } from '../../src/server/http/app.js';
import type { Config } from '../../src/server/config.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

let db: DB;
let config: Config;
let batch: string;
const id = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as any).id as string;
const names = () => getCallList(db).map((i) => i.name.split(' ')[0]);
const key = () => `k-${uuidv7()}`;

beforeEach(async () => {
  ({ db, c: config } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  batch = commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' }).batchId;
});

describe('call list', () => {
  it('starts empty, and an import adds its leads in file order', () => {
    expect(getCallList(db)).toEqual([]);
    const r = addBatchToCallList(db, batch);
    expect(r.added).toBeGreaterThan(1);
    const order = db
      .prepare('SELECT l.first_name FROM lead l JOIN import_row r ON r.id = l.import_row_id WHERE l.batch_id = ? ORDER BY r.row_number')
      .all(batch)
      .map((x: any) => x.first_name);
    expect(names()).toEqual(order);
  });

  it('adds to the bottom, once, and refuses leads that cannot be called', () => {
    const jane = id('Jane');
    expect(addToCallList(db, [jane])).toEqual({ added: 1, already: 0, not_callable: 0 });
    expect(addToCallList(db, [jane])).toEqual({ added: 0, already: 1, not_callable: 0 });
    const other = getCallList(db).length;
    const dead = db.prepare("SELECT id FROM lead WHERE id <> ? LIMIT 1").get(jane) as any;
    addLeadAction(db, dead.id, 'mark_dead', 'test');
    expect(addToCallList(db, [dead.id]).not_callable).toBe(1);
    expect(getCallList(db)).toHaveLength(other);
  });

  it('a call marks the lead worked with its outcome; undo puts it back; changing the outcome shows the new one', () => {
    const jane = id('Jane');
    addToCallList(db, [jane], new Date(Date.now() - 1000).toISOString());
    expect(getCallList(db)[0]!.done).toBeNull();
    const { call_id } = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer', dial_count: 2 });
    expect(getCallList(db)[0]!.done).toMatchObject({ label: 'No answer', dials: 2 });
    const cur = db.prepare('SELECT id FROM call_outcome WHERE call_id = ?').get(call_id) as any;
    changeOutcome(db, call_id, { outcome_code: 'no_appt', expected_current_id: cur.id });
    expect(getCallList(db)[0]!.done?.label).toBe('Talked, no appt');
    expect(recentOutcomes(db)[0]).toMatchObject({ lead_id: jane, label: 'Talked, no appt' });
    voidCall(db, call_id);
    expect(getCallList(db)[0]!.done).toBeNull();
  });

  it('worked leads stay until cleared; skip moves a lead to the bottom; remove takes one off', () => {
    addBatchToCallList(db, batch, new Date(Date.now() - 1000).toISOString());
    const first = getCallList(db)[0]!;
    logManualCall(db, { lead_id: first.lead_id, idempotency_key: key(), outcome_code: 'no_answer' });
    const before = getCallList(db).length;
    expect(getCallList(db).filter((i) => i.done)).toHaveLength(1);
    const second = getCallList(db)[1]!.lead_id;
    moveToBottom(db, second);
    expect(getCallList(db).at(-1)!.lead_id).toBe(second);
    expect(clearWorked(db)).toBe(1);
    expect(getCallList(db)).toHaveLength(before - 1);
    removeFromCallList(db, second);
    expect(getCallList(db).some((i) => i.lead_id === second)).toBe(false);
  });

  it('adds every lead matching the Leads filters, leaving out ones already on the list', () => {
    const r = addMatchingToCallList(db, { status: 'new' });
    expect(r.added).toBeGreaterThan(0);
    expect(addMatchingToCallList(db, { status: 'new', not_on_list: true }).added).toBe(0);
  });
});

describe('clearing, replacing and saved lists', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('clear empties the list; with a name it keeps the leads as a saved list', () => {
    addBatchToCallList(db, batch, ago(5000));
    const n = getCallList(db).length;
    expect(clearCallList(db)).toMatchObject({ removed: n, saved: null });
    expect(getCallList(db)).toEqual([]);
    expect(listSavedLists(db)).toEqual([]);

    addBatchToCallList(db, batch, ago(5000));
    const r = clearCallList(db, '  Marion Co. ');
    expect(getCallList(db)).toEqual([]);
    expect(r.saved).toMatchObject({ name: 'Marion Co.', total: n, to_call: n });
    // A blank name or an empty list saves nothing.
    expect(clearCallList(db, 'Empty').saved).toBeNull();
    expect(listSavedLists(db)).toHaveLength(1);
  });

  it('loading a saved list brings it back in order with worked leads still worked, and puts the current list away', () => {
    addBatchToCallList(db, batch, ago(5000));
    const order = names();
    const first = getCallList(db)[0]!.lead_id;
    logManualCall(db, { lead_id: first, idempotency_key: key(), outcome_code: 'no_answer' });
    const saved = clearCallList(db, 'Area 352').saved!;
    expect(saved.to_call).toBe(saved.total - 1);

    addToCallList(db, [id('Jane')]);
    const r = loadSavedList(db, saved.id, 'Jane only')!;
    expect(r.loaded).toBe(order.length);
    expect(names()).toEqual(order);
    expect(getCallList(db).find((i) => i.lead_id === first)!.done).toMatchObject({ label: 'No answer' });
    expect(callListName(db)).toBe('Area 352');
    // The loaded list left the saved lists; the one it replaced took its place.
    expect(listSavedLists(db).map((l) => l.name)).toEqual(['Jane only']);

    // Clearing again without a name drops the list name too.
    clearCallList(db);
    expect(callListName(db)).toBeNull();
    expect(loadSavedList(db, 'nope')).toBeNull();
    expect(deleteSavedList(db, listSavedLists(db)[0]!.id)).toBe(true);
    expect(listSavedLists(db)).toEqual([]);
  });

  it('over HTTP: replace the list with ticked leads or every match, keeping the old one', async () => {
    const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
    const headers = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };
    const app = await buildApp({ db, config, token: TOKEN });
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });

    addBatchToCallList(db, batch);
    const n = getCallList(db).length;
    const jane = id('Jane');
    const r1 = await post('/api/call-list', { lead_ids: [jane], replace: true, save_current_as: 'First list' });
    expect(r1.json()).toEqual({ added: 1, already: 0, not_callable: 0 });
    expect(getCallList(db).map((i) => i.lead_id)).toEqual([jane]);

    const r2 = await post('/api/call-list/add-matching', { status: 'new', replace: true });
    expect(r2.json().added).toBe(n);

    const got = (await app.inject({ url: '/api/call-list', headers })).json();
    expect(got.items).toHaveLength(n);
    expect(got.saved_lists).toMatchObject([{ name: 'First list', total: n }]);

    const load = await post(`/api/saved-lists/${got.saved_lists[0].id}/load`, { save_current_as: null });
    expect(load.json()).toMatchObject({ loaded: n, saved: null });
    expect((await app.inject({ url: '/api/call-list', headers })).json()).toMatchObject({ name: 'First list', saved_lists: [] });

    expect((await post('/api/call-list/clear', {})).json()).toMatchObject({ removed: n, saved: null });
    expect((await post('/api/saved-lists/missing/load', {})).statusCode).toBe(404);
    await app.close();
  });
});
