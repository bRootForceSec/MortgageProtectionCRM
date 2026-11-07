import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { tagLead } from '../../src/server/domain/tags.js';
import { previewRule, runEventRules, saveRules } from '../../src/server/domain/rules.js';
import { describeAction, STARTER_RULES } from '../../src/shared/rules.js';
import { uuidv7 } from '../../src/server/ids.js';

let db: DB;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const state = (id: string) => db.prepare('SELECT status, next_due_at FROM lead_state WHERE lead_id = ?').get(id) as { status: string; next_due_at: string | null };

beforeEach(async () => {
  db = tempDb().db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
});

describe('a rule that makes a lead come back', () => {
  it('tagging the lead sets it off: due in 15 minutes, then the next step after a try nobody answered, and an answer ends it', () => {
    saveRules(db, [{ id: 'r1', name: 'No-show comeback', enabled: true, trigger: { kind: 'tag_added', tag: 'No show' }, filter: {}, actions: [{ kind: 'come_back', steps: ['15m', '2h'] }] }]);
    const jane = lead('Jane');
    runEventRules(db); // the first look starts the log there: history doesn't set rules off
    const before = Date.now();
    tagLead(db, jane, 'No show');
    runEventRules(db);
    const s = state(jane);
    expect(s.status).toBe('callback');
    const due = Date.parse(s.next_due_at!);
    expect(due).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000);
    expect(due).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);
    expect(db.prepare('SELECT rule_id, rule_name, steps_json FROM lead_comeback WHERE lead_id = ?').get(jane)).toEqual({ rule_id: 'r1', rule_name: 'No-show comeback', steps_json: '["15m","2h"]' });

    logManualCall(db, { lead_id: jane, idempotency_key: uuidv7(), outcome_code: 'no_answer' });
    expect(state(jane).status).toBe('callback');
    expect(Date.parse(state(jane).next_due_at!)).toBeGreaterThan(Date.now() + 110 * 60_000);
    logManualCall(db, { lead_id: jane, idempotency_key: uuidv7(), outcome_code: 'no_appt' });
    expect(state(jane).status).not.toBe('callback');
  });

  it('a preview changes nothing, and the action reads in words', () => {
    const jane = lead('Jane');
    const was = state(jane);
    const run = previewRule(db, { id: 'r1', name: 'All back', enabled: true, trigger: { kind: 'manual' }, filter: {}, actions: [{ kind: 'come_back', steps: ['1d@09:00'] }] });
    expect(run.results[0]!.changed).toBeGreaterThan(0);
    expect(state(jane)).toEqual(was);
    expect((db.prepare('SELECT COUNT(*) n FROM lead_comeback').get() as { n: number }).n).toBe(0);
    expect(describeAction({ kind: 'come_back', steps: ['15m', '1d@09:00'] })).toBe('Come back after 15m, then 1d@09:00');
  });

  it('refuses a step it doesn\'t understand', () => {
    expect(() => saveRules(db, [{ id: 'r1', name: 'x', enabled: true, trigger: { kind: 'manual' }, filter: {}, actions: [{ kind: 'come_back', steps: ['soon'] }] }])).toThrow(/15m, 2h, 3d or 1d@09:00/);
  });

  it('the ready-made no-show rule: a no-show comes back in 15 minutes instead of right away', () => {
    const starter = STARTER_RULES.find((r) => r.name.startsWith('No-shows: come back'))!;
    expect(starter).toMatchObject({ enabled: false, trigger: { kind: 'becomes_true', condition: 'appt_result == "no_show"' }, actions: [{ kind: 'come_back', steps: ['15m', '1d@09:00', '3d'] }] });
    saveRules(db, [{ ...starter, id: 'r1', enabled: true }]);
    const jane = lead('Jane');
    runEventRules(db); // the first look notes who is in already
    logManualCall(db, { lead_id: jane, idempotency_key: uuidv7(), outcome_code: 'appointment' });
    logManualCall(db, { lead_id: jane, idempotency_key: uuidv7(), outcome_code: 'appt_no_show' });
    expect(state(jane)).toMatchObject({ status: 'retry', next_due_at: null });
    const before = Date.now();
    runEventRules(db);
    expect(state(jane).status).toBe('callback');
    expect(Date.parse(state(jane).next_due_at!)).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000);
  });
});
