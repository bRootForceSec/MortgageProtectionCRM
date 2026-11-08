import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tempConfig, tempDb, sampleCsv } from '../helpers.js';
import { migrate, type DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { createCustomField, leadCustomValues } from '../../src/server/domain/customFields.js';
import { deleteTag, ensureTag, leadEvents, renameTag, setTagOnLeads, tagLead } from '../../src/server/domain/tags.js';
import { runRuleById, saveRules } from '../../src/server/domain/rules.js';
import { logManualCall, voidCall } from '../../src/server/domain/calls.js';
import { getLeadDetail } from '../../src/server/domain/leads.js';
import { uuidv7 } from '../../src/server/ids.js';

let db: DB;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
/** What a formula gives a lead, through a formula field (the way conditions will be read). */
const evaluate = (first: string, f: string) => {
  const field = createCustomField(db, { label: `F${uuidv7().slice(-8)}`, type: 'formula', formula: f });
  return leadCustomValues(db, lead(first)).find((v) => v.field_id === field.id)!.value;
};

beforeEach(async () => {
  db = tempDb().db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
});

describe("the lead's log", () => {
  it('keeps every tag put on and taken off, with what did it, even after the tag is renamed or deleted', () => {
    const jane = lead('Jane');
    tagLead(db, jane, 'Spanish');
    const hot = ensureTag(db, 'Hot');
    saveRules(db, [{ id: 'r1', name: 'Tag them hot', enabled: true, trigger: { kind: 'manual' }, filter: { search: 'Jane' }, actions: [{ kind: 'add_tag', tag: 'Hot' }] }]);
    runRuleById(db, 'r1', false);
    renameTag(db, hot.id, 'Very hot');
    deleteTag(db, ensureTag(db, 'Spanish').id);
    const log = leadEvents(db, jane).map((e) => [e.kind, e.tag_name, e.source, e.source_name]);
    expect(log).toEqual(expect.arrayContaining([
      ['tag_added', 'Spanish', 'you', null],
      ['tag_added', 'Hot', 'rule', 'Tag them hot'],
      ['tag_removed', 'Spanish', 'you', null],
    ]));
    expect(log).toHaveLength(3);
    // Nothing goes in lead_change for tags any more; the lead page reads the log.
    expect(db.prepare("SELECT COUNT(*) n FROM lead_change WHERE field = 'tag'").get()).toEqual({ n: 0 });
    expect(getLeadDetail(db, '', jane)!.events).toHaveLength(3);
  });

  it('a rule preview logs nothing', () => {
    saveRules(db, [{ id: 'r1', name: 'Hot', enabled: true, trigger: { kind: 'manual' }, filter: {}, actions: [{ kind: 'add_tag', tag: 'Hot' }] }]);
    runRuleById(db, 'r1', true);
    expect(db.prepare('SELECT COUNT(*) n FROM lead_event').get()).toEqual({ n: 0 });
  });
});

describe('formulas read the log', () => {
  it('has, added, times (in a window), before, days_since and hours_since', () => {
    const jane = lead('Jane');
    const t = (name: string) => ensureTag(db, name).id;
    setTagOnLeads(db, [jane], t('No answer'), true, ago(10));
    setTagOnLeads(db, [jane], t('No answer'), false, ago(9));
    setTagOnLeads(db, [jane], t('No answer'), true, ago(3.1));
    setTagOnLeads(db, [jane], t('No answer'), false, ago(3));
    setTagOnLeads(db, [jane], t('No answer'), true, ago(1));
    setTagOnLeads(db, [jane], t('Appt set'), true, ago(5));
    setTagOnLeads(db, [jane], t('No show'), true, ago(2));
    setTagOnLeads(db, [jane], t('Called'), true, ago(0.25));
    expect(evaluate('Jane', 'has("no answer")')).toBe('yes');
    expect(evaluate('Jane', 'has("Sold")')).toBe('no');
    expect(evaluate('Jane', 'times("No answer")')).toBe('3');
    expect(evaluate('Jane', 'times("No answer", 7)')).toBe('2');
    expect(evaluate('Jane', 'times("Sold")')).toBe('0');
    expect(evaluate('Jane', 'before("Appt set", "No show")')).toBe('yes');
    expect(evaluate('Jane', 'before("No show", "Appt set")')).toBe('no');
    expect(evaluate('Jane', 'before("Appt set", "Sold")')).toBe('no');
    // Calendar days in your time: two days ago at this hour is 2 days back.
    expect(evaluate('Jane', 'days_since(added("No show"))')).toBe('2');
    expect(Number(evaluate('Jane', 'hours_since(added("Called"))'))).toBeCloseTo(6, 0);
    expect(evaluate('Jane', 'blank(added("Sold"))')).toBe('yes');
    expect(evaluate('Jane', 'days_since(removed("No answer"))')).toBe('3');
    // A condition: no-show in the last 3 days, after the appointment was set.
    expect(evaluate('Jane', 'has("No show") and hours_since(added("No show")) < 72 and before("Appt set", "No show")')).toBe('yes');
  });

  it('pressed counts calls by outcome name or code, leaves out undone calls, and takes a window', () => {
    const ann = lead('Ann');
    const call = (code: string) => logManualCall(db, { lead_id: ann, idempotency_key: `k-${uuidv7()}`, outcome_code: code }).call_id;
    call('no_answer');
    call('no_answer');
    const undone = call('no_answer');
    voidCall(db, undone, 'oops');
    expect(evaluate('Ann', 'pressed("no_answer")')).toBe('2');
    expect(evaluate('Ann', 'pressed("No answer", 1)')).toBe('2');
    expect(evaluate('Ann', 'pressed("Appt set")')).toBe('0');
  });
});

describe('migration 031', () => {
  it('moves the tag history out of lead_change into the log, and logs tags that had no line', () => {
    const c = tempConfig();
    const old = path.join(c.dataDir, 'old-migrations');
    fs.mkdirSync(old);
    const src = path.resolve('src/server/db/migrations');
    for (const f of fs.readdirSync(src).filter((f) => f < '031')) fs.copyFileSync(path.join(src, f), path.join(old, f));
    const d = new Database(c.dbFile);
    d.pragma('foreign_keys = ON');
    migrate(d, old);
    const now = '2026-11-01T12:00:00.000Z';
    const b = uuidv7();
    d.prepare("INSERT INTO import_batch (id, name, source, file_name, file_sha256, imported_at, column_mapping_json) VALUES (?, 'b', 'x', 'f', 's', ?, '{}')").run(b, now);
    const r = uuidv7(), l = uuidv7();
    d.prepare("INSERT INTO import_row (id, batch_id, row_number, raw_json, row_fingerprint, status) VALUES (?, ?, 1, '{}', ?, 'accepted')").run(r, b, r);
    d.prepare("INSERT INTO lead (id, batch_id, import_row_id, first_name, phone_e164, phone_valid, coborrower_signal, created_at) VALUES (?, ?, ?, 'Jo', '+13175550100', 1, 'unknown', ?)").run(l, b, r, now);
    const spanish = uuidv7(), friday = uuidv7();
    d.prepare('INSERT INTO tag (id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)').run(spanish, 'Spanish', now, friday, 'Friday list', now);
    const change = d.prepare('INSERT INTO lead_change (id, lead_id, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    change.run(uuidv7(), l, 'tag', null, 'Spanish', '2026-11-01T12:00:00.000Z');
    change.run(uuidv7(), l, 'tag', 'Spanish', null, '2026-11-02T12:00:00.000Z');
    change.run(uuidv7(), l, 'tag', null, 'Friday', '2026-11-03T12:00:00.000Z'); // renamed since to "Friday list"
    change.run(uuidv7(), l, 'first_name', 'Joe', 'Jo', '2026-11-03T12:00:00.000Z');
    d.prepare('INSERT INTO lead_tag (lead_id, tag_id, added_at) VALUES (?, ?, ?)').run(l, friday, '2026-11-03T12:00:00.000Z');
    migrate(d, src);
    expect(d.prepare('SELECT at, kind, tag_id, tag_name, source FROM lead_event ORDER BY at, kind DESC').all()).toEqual([
      { at: '2026-11-01T12:00:00.000Z', kind: 'tag_added', tag_id: spanish, tag_name: 'Spanish', source: 'you' },
      { at: '2026-11-02T12:00:00.000Z', kind: 'tag_removed', tag_id: spanish, tag_name: 'Spanish', source: 'you' },
      { at: '2026-11-03T12:00:00.000Z', kind: 'tag_added', tag_id: null, tag_name: 'Friday', source: 'you' },
      { at: '2026-11-03T12:00:00.000Z', kind: 'tag_added', tag_id: friday, tag_name: 'Friday list', source: 'you' },
    ]);
    expect(d.prepare('SELECT field FROM lead_change').all()).toEqual([{ field: 'first_name' }]);
    expect(d.pragma('foreign_key_check')).toEqual([]);
    d.close();
  }, 90_000);
});

describe('conditions filter leads', () => {
  it('a Python condition in the Leads filters, checked as you type, and kept by rules', async () => {
    const { matchingLeadIds, toLeadFilter } = await import('../../src/server/domain/callList.js');
    const { LeadQuery } = await import('../../src/shared/leadFilter.js');
    const { checkCondition } = await import('../../src/server/domain/formulas.js');
    const jane = lead('Jane');
    tagLead(db, jane, 'No show');
    const matching = (where: string) => matchingLeadIds(db, toLeadFilter(LeadQuery.parse({ where })));
    expect(matching('has("No show") and hours_since(added("No show")) < 72')).toEqual([jane]);
    expect(matching('not has("No show")')).not.toContain(jane);
    expect(() => matching('attempts +')).toThrow(/The condition: the formula stops too soon/);
    expect(() => matching('attempts + 1')).toThrow(/has to be yes or no/);
    const total = (db.prepare('SELECT COUNT(*) n FROM lead').get() as { n: number }).n;
    expect(checkCondition(db, 'has("No show")')).toEqual({ error: null, at: null, matched: 1, total });
    expect(checkCondition(db, 'has("No show"')).toMatchObject({ error: expect.stringMatching(/\)/), matched: 0 });
    expect(() => saveRules(db, [{ id: 'r', name: 'Bad', enabled: true, trigger: { kind: 'manual' }, filter: { where: 'has(' }, actions: [{ kind: 'add_tag', tag: 'X' }] }])).toThrow(/Bad: the condition/);
    saveRules(db, [{ id: 'r', name: 'Rebook', enabled: true, trigger: { kind: 'manual' }, filter: { where: 'has("No show")' }, actions: [{ kind: 'add_tag', tag: 'Rebook' }] }]);
    expect(runRuleById(db, 'r', false).matched).toBe(1);
    expect(leadEvents(db, jane)[0]).toMatchObject({ kind: 'tag_added', tag_name: 'Rebook', source: 'rule', source_name: 'Rebook' });
  });
});
