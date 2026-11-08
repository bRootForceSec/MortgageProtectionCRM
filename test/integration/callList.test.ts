import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, changeOutcome, voidCall, addLeadAction } from '../../src/server/domain/calls.js';
import {
  addBatchToCallList, addMatchingToCallList, addToCallList, clearWorked, getCallList, moveToBottom, recentOutcomes, removeFromCallList,
  callListName, callListMeta, clearCallList, deleteSavedList, listSavedLists, loadSavedList, saveCallList, saveCallListAs, setCalledBack, leadFilterWhere,
} from '../../src/server/domain/callList.js';
import { loadCallingSettings, saveCallingSettings } from '../../src/server/domain/callingSettings.js';
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
    expect(addToCallList(db, [jane])).toEqual({ added: 1, already: 0, not_callable: 0, skipped: [] });
    expect(addToCallList(db, [jane])).toEqual({ added: 0, already: 1, not_callable: 0, skipped: [] });
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
    expect(getCallList(db)[0]!.done?.label).toBe('Picked up');
    expect(recentOutcomes(db)[0]).toMatchObject({ lead_id: jane, label: 'Picked up' });
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

  it('a lead an appointment put back goes to the top when added, unless Settings says otherwise', () => {
    const [jane, robert, ann] = [id('Jane'), id('Robert'), id('Ann')];
    addToCallList(db, [jane]);
    // Robert had an appointment and didn't show; Ann sat with no sale.
    for (const lead of [robert, ann]) {
      logManualCall(db, { lead_id: lead, idempotency_key: key(), outcome_code: 'appointment' });
      logManualCall(db, { lead_id: lead, idempotency_key: key(), outcome_code: lead === robert ? 'appt_no_show' : 'appt_sat_no_sale' });
    }
    expect(addToCallList(db, [robert, ann]).added).toBe(2);
    expect(names()).toEqual(['Robert', 'Ann', 'Jane']);
    // After that it's a plain list: skip moves one down.
    moveToBottom(db, robert);
    expect(names()).toEqual(['Ann', 'Jane', 'Robert']);
    // Turned off, they go to the bottom like any other lead.
    removeFromCallList(db, ann);
    saveCallingSettings(db, { ...loadCallingSettings(db), missed_appts_first: false });
    addToCallList(db, [ann]);
    expect(names()).toEqual(['Jane', 'Robert', 'Ann']);
  });

  it('adds every lead matching the Leads filters, leaving out ones already on the list', () => {
    const r = addMatchingToCallList(db, { status: 'new' });
    expect(r.added).toBeGreaterThan(0);
    expect(addMatchingToCallList(db, { status: 'new', not_on_list: true }).added).toBe(0);
  });
});

describe('called me back', () => {
  it('ticks and unticks a lead, and the list shows it', () => {
    const jane = id('Jane');
    addToCallList(db, [jane]);
    expect(getCallList(db)[0]!.called_back_at).toBeNull();
    const at = setCalledBack(db, jane, true);
    expect(at).toBeTruthy();
    // Ticking again keeps the first time.
    expect(setCalledBack(db, jane, true, '2030-01-01T00:00:00.000Z')).toBe(at);
    expect(getCallList(db)[0]!.called_back_at).toBe(at);
    expect(setCalledBack(db, jane, false)).toBeNull();
    expect(getCallList(db)[0]!.called_back_at).toBeNull();
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

  it('loading a saved list brings it back in order with worked leads still worked; the saved copy stays', () => {
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
    expect(callListMeta(db)).toEqual({ name: 'Area 352', saved_list_id: saved.id, unsaved: false });
    // The loaded list stays saved, next to the one it replaced.
    expect(listSavedLists(db).map((l) => l.name).sort()).toEqual(['Area 352', 'Jane only']);

    // Clearing again without a name drops the list name too.
    clearCallList(db);
    expect(callListName(db)).toBeNull();
    expect(loadSavedList(db, 'nope')).toBeNull();
    for (const l of listSavedLists(db)) expect(deleteSavedList(db, l.id)).toBe(true);
    expect(listSavedLists(db)).toEqual([]);
  });

  it('save writes over the list it is; save as makes a new one or replaces the one with that name', () => {
    addBatchToCallList(db, batch, ago(5000));
    const n = getCallList(db).length;
    expect(callListMeta(db)).toEqual({ name: null, saved_list_id: null, unsaved: true });
    // Not saved yet: Save needs a name first.
    expect(() => saveCallList(db)).toThrow(/Save as/);

    const a = saveCallListAs(db, ' Marion ')!;
    expect(a).toMatchObject({ name: 'Marion', total: n });
    expect(callListMeta(db)).toEqual({ name: 'Marion', saved_list_id: a.id, unsaved: false });
    // Saving doesn't touch the call list.
    expect(getCallList(db)).toHaveLength(n);

    // A change (skip, remove, add) shows as unsaved until you save.
    removeFromCallList(db, getCallList(db)[0]!.lead_id);
    expect(callListMeta(db).unsaved).toBe(true);
    expect(saveCallList(db)).toMatchObject({ id: a.id, name: 'Marion', total: n - 1 });
    expect(callListMeta(db).unsaved).toBe(false);
    moveToBottom(db, getCallList(db)[0]!.lead_id);
    expect(callListMeta(db).unsaved).toBe(true);

    // Save as a new name: a second list, and the call list is now that one.
    const b = saveCallListAs(db, 'Marion v2')!;
    expect(b.id).not.toBe(a.id);
    expect(callListMeta(db)).toMatchObject({ name: 'Marion v2', saved_list_id: b.id, unsaved: false });
    // Save as an existing name (any case) writes over it rather than making a duplicate.
    const c = saveCallListAs(db, 'marion')!;
    expect(c.id).toBe(a.id);
    expect(listSavedLists(db)).toHaveLength(2);
    expect(saveCallListAs(db, '   ')).toBeNull();

    // Deleting the list it is leaves the leads on the call list, unsaved.
    deleteSavedList(db, a.id);
    expect(callListMeta(db)).toMatchObject({ saved_list_id: null, unsaved: true });
    expect(getCallList(db)).toHaveLength(n - 1);
    // An empty list is never "unsaved".
    clearCallList(db);
    expect(callListMeta(db).unsaved).toBe(false);
  });

  it("filters: no answer vs talked, last call today; worked leads can go back on the list", async () => {
    const jane = id('Jane');
    const other = (db.prepare('SELECT id FROM lead WHERE id <> ? LIMIT 1').get(jane) as any).id as string;
    addToCallList(db, [jane, other], new Date(Date.now() - 1000).toISOString());
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    logManualCall(db, { lead_id: other, idempotency_key: key(), outcome_code: 'no_appt' });
    const start = new Date(Date.now() - 3600_000).toISOString();
    const match = (f: object) =>
      db.prepare(`SELECT l.id FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE ${leadFilterWhere(db, f).sql}`).all(leadFilterWhere(db, f).params).map((r: any) => r.id);
    expect(match({ status: 'no_answer' })).toEqual([jane]);
    expect(match({ status: 'talked' })).toEqual([other]);
    expect(match({ status: 'retry' }).sort()).toEqual([jane, other].sort());
    expect(match({ status: 'no_answer', tried_after: new Date(Date.now() + 60_000).toISOString() })).toEqual([]);
    // Both were called from the list, so they count as off it and can be added back.
    expect(match({ status: 'retry', not_on_list: true })).toHaveLength(2);

    expect(addMatchingToCallList(db, { status: 'no_answer', tried_after: start })).toEqual({ added: 1, already: 0, not_callable: 0, skipped: [] });
    const list = getCallList(db);
    expect(list.at(-1)).toMatchObject({ lead_id: jane, done: null });
    expect(list.find((i) => i.lead_id === other)!.done).not.toBeNull();
    // Now waiting to be called, so adding it again does nothing.
    expect(addToCallList(db, [jane])).toEqual({ added: 0, already: 1, not_callable: 0, skipped: [] });

    const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
    const headers = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };
    const app = await buildApp({ db, config, token: TOKEN });
    const r = await app.inject({ url: `/api/leads?status=no_answer&tried_after=${encodeURIComponent(start)}`, headers });
    expect(r.json().rows.map((x: any) => x.id)).toEqual([jane]);
    await app.close();
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
    expect(r1.json()).toEqual({ added: 1, already: 0, not_callable: 0, skipped: [] });
    expect(getCallList(db).map((i) => i.lead_id)).toEqual([jane]);

    const r2 = await post('/api/call-list/add-matching', { status: 'new', replace: true });
    expect(r2.json().added).toBe(n);

    const got = (await app.inject({ url: '/api/call-list', headers })).json();
    expect(got.items).toHaveLength(n);
    expect(got.saved_lists).toMatchObject([{ name: 'First list', total: n }]);

    const load = await post(`/api/saved-lists/${got.saved_lists[0].id}/load`, { save_current_as: null });
    expect(load.json()).toMatchObject({ loaded: n, saved: null });
    expect((await app.inject({ url: '/api/call-list', headers })).json()).toMatchObject({ name: 'First list', unsaved: false, saved_lists: [{ name: 'First list' }] });

    // Save and Save as.
    removeFromCallList(db, jane);
    expect((await post('/api/call-list/save', {})).json()).toMatchObject({ saved: { name: 'First list', total: n - 1 } });
    expect((await post('/api/call-list/save-as', { name: 'Second' })).json()).toMatchObject({ saved: { name: 'Second' } });
    expect((await post('/api/call-list/save-as', { name: ' ' })).statusCode).toBe(400);

    expect((await post('/api/call-list/clear', {})).json()).toMatchObject({ removed: n - 1, saved: null });
    expect((await post('/api/saved-lists/missing/load', {})).statusCode).toBe(404);
    await app.close();
  });
});
