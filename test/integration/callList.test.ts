import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, changeOutcome, voidCall, addLeadAction } from '../../src/server/domain/calls.js';
import {
  addBatchToCallList, addMatchingToCallList, addToCallList, clearWorked, getCallList, moveToBottom, recentOutcomes, removeFromCallList,
} from '../../src/server/domain/callList.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

let db: DB;
let batch: string;
const id = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as any).id as string;
const names = () => getCallList(db).map((i) => i.name.split(' ')[0]);
const key = () => `k-${uuidv7()}`;

beforeEach(async () => {
  ({ db } = tempDb());
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
