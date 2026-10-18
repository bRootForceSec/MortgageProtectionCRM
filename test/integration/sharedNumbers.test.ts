import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, addLeadAction, voidCall } from '../../src/server/domain/calls.js';
import { getQueue } from '../../src/server/domain/queue.js';
import { rebuildLeadState, verifyLeadState } from '../../src/server/domain/leadState.js';
import { timeZoneFor } from '../../src/server/domain/normalize.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

// In the sample sheet Jane Doe and John Doe share one home number; Robert Ray has his own.
let db: DB;
let jane: string;
let john: string;
let robert: string;
const key = () => `k-${uuidv7()}`;
const state = (id: string) => db.prepare('SELECT * FROM lead_state WHERE lead_id = ?').get(id) as any;
const idOf = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as any).id as string;

beforeEach(async () => {
  ({ db } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  jane = idOf('Jane');
  john = idOf('John');
  robert = idOf('Robert');
});

describe('leads that share a number', () => {
  it('dead pile on one takes the other out of the queue, and restoring the first brings both back', () => {
    addLeadAction(db, jane, 'mark_dead', 'asked not to be called');
    expect(state(john).status).toBe('dead');
    expect(state(john).block_reason).toMatch(/Jane Doe, who is in the dead pile/);
    expect(getQueue(db).items.map((i) => i.lead_id)).not.toContain(john);
    addLeadAction(db, jane, 'restore');
    expect(state(john).status).toBe('new');
    expect(state(john).block_reason).toBeNull();
  });

  it('restoring the other lead brings back only that one', () => {
    addLeadAction(db, jane, 'mark_dead');
    addLeadAction(db, john, 'restore');
    expect(state(john).status).toBe('new');
    expect(state(jane).status).toBe('dead');
  });

  it('a bad number on one marks the other as a bad number too; undo clears both', () => {
    const r = logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'bad_number' });
    expect(state(jane).status).toBe('invalid');
    expect(state(john).status).toBe('invalid');
    expect(state(john).block_reason).toMatch(/Jane Doe, marked as a bad number/);
    expect(state(robert).status).toBe('new');
    voidCall(db, r.call_id);
    expect(state(john).status).toBe('new');
  });

  it('a lead imported later with a number already in the dead pile starts in the dead pile', async () => {
    addLeadAction(db, robert, 'mark_dead');
    const parsed = await parseSpreadsheet(sampleCsv([['Rob Ray Jr', '614.555.0102', 'Chase', 1, 30, '', '', 'Dayton', 'OH', '45402', '', '', '', '', '', '']]), 'b.csv');
    const sheet = parsed.sheets[0]!;
    commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b2' });
    expect(state(idOf('Rob Ray')).status).toBe('dead');
  });

  it('keeps the derived state consistent with a fresh rebuild', () => {
    addLeadAction(db, jane, 'mark_dead');
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'bad_number' });
    expect(verifyLeadState(db)).toEqual([]);
  });
});

describe('bad number on a lead with another number', () => {
  beforeEach(() => {
    db.prepare("UPDATE lead SET phone2_e164 = '+16145550177', phone2_raw = '614-555-0177' WHERE id = ?").run(robert);
    rebuildLeadState(db, [robert]);
  });

  it('switches to the other number and stays in the queue, due now', () => {
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'bad_number' });
    const s = state(robert);
    expect(s.status).toBe('retry');
    expect(s.active_phone_e164).toBe('+16145550177');
    expect(JSON.parse(s.blocked_phones_json)).toEqual(['+16145550102']);
    const item = getQueue(db).items.find((i) => i.lead_id === robert)!;
    expect(item.phone_e164).toBe('+16145550177');
    expect(item.bucket).toBe('retry');
  });

  it('logs the next call to the other number, and a second bad number ends it', () => {
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'bad_number' });
    const r = logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'bad_number' });
    expect((db.prepare('SELECT to_e164 FROM call WHERE id = ?').get(r.call_id) as any).to_e164).toBe('+16145550177');
    expect(state(robert).status).toBe('invalid');
  });

  it('a no answer on the main number keeps calling the main number', () => {
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'no_answer' });
    expect(state(robert).active_phone_e164).toBe('+16145550102');
    expect(state(robert).blocked_phones_json).toBeNull();
  });
});

describe('queue counts', () => {
  it('"waiting for later" follows the county filter', () => {
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'no_answer' });
    const robertCounty = (db.prepare('SELECT county_key FROM lead WHERE id = ?').get(robert) as any).county_key as string;
    expect(getQueue(db, { counties: [robertCounty] }).waiting_later).toBe(1);
    expect(getQueue(db, { counties: ['XX|NOWHERE'] }).waiting_later).toBe(0);
  });
});

describe('time zones by county', () => {
  it('uses Central time for Indiana\'s Central counties and Eastern for the rest', () => {
    expect(timeZoneFor('IN', 'IN|LAKE')).toBe('America/Chicago');
    expect(timeZoneFor('IN', 'IN|VANDERBURGH')).toBe('America/Chicago');
    expect(timeZoneFor('IN', 'IN|ST JOSEPH')).toBe('America/Indiana/Indianapolis');
    expect(timeZoneFor('MI', 'MI|GOGEBIC')).toBe('America/Menominee');
    expect(timeZoneFor('OH', null)).toBe('America/New_York');
    expect(timeZoneFor(null, null)).toBeNull();
  });
});
