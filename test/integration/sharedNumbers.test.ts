import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv, dueLeads } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, addLeadAction, voidCall } from '../../src/server/domain/calls.js';
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
    expect(dueLeads(db).map((l) => l.id)).not.toContain(john);
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
    db.prepare("INSERT INTO lead_other_phone (lead_id, pos, raw, e164, label) VALUES (?, 1, '614-555-0177', '+16145550177', 'Alternate')").run(robert);
    rebuildLeadState(db, [robert]);
  });

  it('switches to the other number and stays in the queue, due now', () => {
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'bad_number' });
    const s = state(robert);
    expect(s.status).toBe('retry');
    expect(s.active_phone_e164).toBe('+16145550177');
    expect(JSON.parse(s.blocked_phones_json)).toEqual(['+16145550102']);
    const item = dueLeads(db).find((l) => l.id === robert)!;
    expect(item.phone_e164).toBe('+16145550177');
    expect(item.status).toBe('retry');
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

describe('a lead with many numbers', () => {
  it('rules out a fourth number shared with a dead-pile lead, and calls the next one', () => {
    const ins = db.prepare("INSERT INTO lead_other_phone (lead_id, pos, raw, e164, label) VALUES (?, ?, ?, ?, NULL)");
    ['+13175550171', '+13175550172', '+13175550173', '+16145550199'].forEach((p, i) => ins.run(robert, i + 1, p, p));
    // Ann's main number is Robert's fourth other number.
    const ann = idOf('Ann');
    db.prepare("UPDATE lead SET phone_e164 = '+16145550199' WHERE id = ?").run(ann);
    rebuildLeadState(db, [robert, ann]);
    addLeadAction(db, ann, 'mark_dead');
    expect(JSON.parse(state(robert).blocked_phones_json)).toEqual(['+16145550199']);
    expect(state(robert).active_phone_e164).toBe('+16145550102');
    // Three bad numbers in a row: the lead keeps going to the next working one.
    for (const next of ['+13175550171', '+13175550172', '+13175550173']) {
      logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'bad_number' });
      expect(state(robert).active_phone_e164).toBe(next);
    }
    logManualCall(db, { lead_id: robert, idempotency_key: key(), outcome_code: 'bad_number' });
    // Every number is ruled out, one of them by a dead-pile lead: this lead goes to the dead pile too.
    expect(state(robert).status).toBe('dead');
    expect(verifyLeadState(db)).toEqual([]);
  });
});
