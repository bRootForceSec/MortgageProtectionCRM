import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { leadTags, setTagOnLeads, ensureTag, tagLead } from '../../src/server/domain/tags.js';
import { saveStatuses } from '../../src/server/domain/statuses.js';
import { createCustomField, leadCustomValues, setCustomValues } from '../../src/server/domain/customFields.js';
import { ruleRuns, runEventRules, runRule, saveRules } from '../../src/server/domain/rules.js';
import { listLeads } from '../../src/server/domain/leads.js';
import { toLeadFilter } from '../../src/server/domain/callList.js';
import { checkCondition } from '../../src/server/domain/formulas.js';
import { LeadQuery } from '../../src/shared/leadFilter.js';
import { describeAction, describeTrigger, type Rule } from '../../src/shared/rules.js';
import { buildApp } from '../../src/server/http/app.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const write = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const rule = (over: Partial<Rule>): Rule => ({ id: uuidv7(), name: 'Test', enabled: true, trigger: { kind: 'manual' }, filter: {}, actions: [{ kind: 'add_to_list' }], ...over });
const tags = (id: string) => leadTags(db, id).map((t) => t.name);
const untag = (id: string, name: string) => setTagOnLeads(db, [id], ensureTag(db, name).id, false);
const counter = (fieldId: string, id: string) => leadCustomValues(db, id).find((v) => v.field_id === fieldId)?.value;

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
  runEventRules(db); // the first look notes where the log is; history doesn't set rules off
});

describe('rules on lead changes', () => {
  it('a tag put on or taken off sets off rules for that lead only, and their tags set off more rules', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    saveRules(db, [
      rule({ name: 'Appt set clears no answer', trigger: { kind: 'tag_added', tag: 'appt set' }, actions: [{ kind: 'remove_tag', tag: 'No answer' }, { kind: 'add_tag', tag: 'Booked' }] }),
      rule({ name: 'Booked is hot', trigger: { kind: 'tag_added', tag: 'Booked' }, actions: [{ kind: 'add_tag', tag: 'Hot' }] }),
      rule({ name: 'Unbooked', trigger: { kind: 'tag_removed', tag: 'Booked' }, actions: [{ kind: 'add_tag', tag: 'Rebook' }] }),
    ]);
    tagLead(db, jane, 'No answer');
    tagLead(db, robert, 'No answer');
    tagLead(db, jane, 'Appt set');
    const runs = runEventRules(db);
    expect(runs.map((r) => [r.rule_name, r.matched, r.error])).toEqual([['Appt set clears no answer', 1, null], ['Booked is hot', 1, null]]);
    expect(tags(jane)).toEqual(['Appt set', 'Booked', 'Hot']);
    expect(tags(robert)).toEqual(['No answer']);
    // The tag a rule put on says which rule did it.
    const line = db.prepare("SELECT source, source_name FROM lead_event WHERE lead_id = ? AND tag_name = 'Hot'").get(jane);
    expect(line).toEqual({ source: 'rule', source_name: 'Booked is hot' });
    expect(runEventRules(db)).toEqual([]);
    untag(jane, 'Booked');
    expect(runEventRules(db).map((r) => r.rule_name)).toEqual(['Unbooked']);
    expect(tags(jane)).toContain('Rebook');
  });

  it("the rule's filters still apply: it acts only on changed leads that fit them", () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    saveRules(db, [rule({ trigger: { kind: 'tag_added', tag: 'Hot' }, filter: { where: 'state = "OH" and age > 55' }, actions: [{ kind: 'add_tag', tag: 'Older' }] })]);
    tagLead(db, jane, 'Hot');
    tagLead(db, robert, 'Hot');
    expect(runEventRules(db).map((r) => r.matched)).toEqual([1]);
    expect(tags(robert)).toContain('Older');
    expect(tags(jane)).not.toContain('Older');
  });

  it('entering or leaving a status, and a condition turning true; switching one on fires only for later changes', () => {
    const jane = lead('Jane');
    const ann = lead('Ann');
    tagLead(db, ann, 'No show'); // already in the status before the rule exists
    saveStatuses(db, [{ id: 's1', name: 'Needs rebook', condition: 'has("No show") and not has("Appt set")', color: 'red', tab: false }]);
    saveRules(db, [
      rule({ name: 'In', trigger: { kind: 'status', status_id: 's1', when: 'enters' }, actions: [{ kind: 'add_tag', tag: 'Call back' }] }),
      rule({ name: 'Out', trigger: { kind: 'status', status_id: 's1', when: 'leaves' }, actions: [{ kind: 'remove_tag', tag: 'Call back' }] }),
      rule({ name: 'Many tries', trigger: { kind: 'becomes_true', condition: 'times("No show") >= 2' }, actions: [{ kind: 'add_tag', tag: 'Ghosting' }] }),
    ]);
    expect(runEventRules(db)).toEqual([]); // the first look only notes who's in
    expect(tags(ann)).toEqual(['No show']);
    tagLead(db, jane, 'No show');
    expect(runEventRules(db).map((r) => r.rule_name)).toEqual(['In']);
    expect(tags(jane)).toEqual(['Call back', 'No show']);
    tagLead(db, jane, 'Appt set');
    expect(runEventRules(db).map((r) => r.rule_name)).toEqual(['Out']);
    expect(tags(jane)).toEqual(['Appt set', 'No show']);
    untag(jane, 'No show');
    untag(jane, 'Appt set');
    tagLead(db, jane, 'No show');
    expect(runEventRules(db).map((r) => r.rule_name).sort()).toEqual(['In', 'Many tries']);
    expect(tags(jane)).toEqual(['Call back', 'Ghosting', 'No show']);
    // Switched off and on again: starts fresh, without firing for who's in now.
    const all = saveRules(db, []);
    runEventRules(db);
    expect(db.prepare('SELECT COUNT(*) n FROM rule_watch').get()).toEqual({ n: 0 });
    expect(all).toEqual([]);
  });

  it('the loop guard: a rule set off again for the same lead runs once, and the log says it stopped a loop', () => {
    const jane = lead('Jane');
    saveRules(db, [
      rule({ name: 'Ping', trigger: { kind: 'tag_added', tag: 'Ping' }, actions: [{ kind: 'remove_tag', tag: 'Ping' }, { kind: 'add_tag', tag: 'Pong' }] }),
      rule({ name: 'Pong', trigger: { kind: 'tag_added', tag: 'Pong' }, actions: [{ kind: 'remove_tag', tag: 'Pong' }, { kind: 'add_tag', tag: 'Ping' }] }),
    ]);
    tagLead(db, jane, 'Ping');
    const runs = runEventRules(db);
    expect(runs.map((r) => [r.rule_name, r.error ? 'stopped' : 'ran'])).toEqual([['Ping', 'ran'], ['Pong', 'ran'], ['Ping', 'stopped']]);
    expect(tags(jane)).toEqual(['Ping']);
    const log = ruleRuns(db);
    expect(log[0]).toMatchObject({ rule_name: 'Ping', matched: 1, error: expect.stringContaining('stopped a loop') });
    expect(log[0]!.leads).toEqual([{ id: jane, name: 'Jane Doe' }]);
  });

  it('counters: rules add to them and set them, nothing else can; filters, formulas and conditions read them, 0 by default', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    const f = createCustomField(db, { label: 'No-answer streak', type: 'counter' });
    expect(counter(f.id, jane)).toBe('0');
    expect(() => setCustomValues(db, jane, { [f.id]: '3' })).toThrow(/only rules change it/);
    expect(() => saveRules(db, [rule({ actions: [{ kind: 'set_field', field_id: f.id, value: '2' }] })])).toThrow(/Change a counter/);
    saveRules(db, [
      rule({ name: 'Count', trigger: { kind: 'tag_added', tag: 'No answer' }, actions: [{ kind: 'counter', field_id: f.id, op: 'add', by: 1 }, { kind: 'remove_tag', tag: 'No answer' }] }),
      rule({ name: 'Reset', trigger: { kind: 'tag_added', tag: 'Picked up' }, actions: [{ kind: 'counter', field_id: f.id, op: 'set', by: 0 }] }),
      rule({ name: 'Streak', trigger: { kind: 'becomes_true', condition: 'field("No-answer streak") >= 3' }, actions: [{ kind: 'add_tag', tag: 'Ghosting' }] }),
    ]);
    runEventRules(db);
    for (let i = 0; i < 3; i++) {
      tagLead(db, jane, 'No answer');
      runEventRules(db);
    }
    expect(counter(f.id, jane)).toBe('3');
    expect(counter(f.id, robert)).toBe('0');
    expect(tags(jane)).toEqual(['Ghosting']);
    expect(checkCondition(db, '[No-answer streak] = 0')).toMatchObject({ error: null });
    const rows = listLeads(db, toLeadFilter(LeadQuery.parse({ field_id: f.id, field_min: '2' }))).rows;
    expect(rows.map((r) => r.id)).toEqual([jane]);
    tagLead(db, jane, 'Picked up');
    runEventRules(db);
    expect(counter(f.id, jane)).toBe('0');
    // Each change is in the lead's history under the counter's name.
    expect(db.prepare('SELECT COUNT(*) n FROM lead_change WHERE lead_id = ? AND field = ?').get(jane, 'No-answer streak')).toEqual({ n: 4 });
    // Preview of a counter rule changes nothing.
    const preview = runRule(db, rule({ actions: [{ kind: 'counter', field_id: f.id, op: 'add', by: -2 }] }), 'manual', { dryRun: true, leadIds: [jane] });
    expect(preview.results).toEqual([{ action: { kind: 'counter', field_id: f.id, op: 'add', by: -2 }, changed: 1, note: null }]);
    expect(counter(f.id, jane)).toBe('0');
  });

  it('runs right after a change made in the app, so the answer already shows what rules did', async () => {
    const jane = lead('Jane');
    saveRules(db, [rule({ trigger: { kind: 'tag_added', tag: 'Hot' }, actions: [{ kind: 'add_tag', tag: 'Call today' }] })]);
    const res = await app.inject({ method: 'POST', url: `/api/leads/${jane}/tags`, headers: write, payload: { name: 'Hot' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((t: { name: string }) => t.name)).toEqual(['Call today', 'Hot']);
  });

  it('checks the new triggers on save, and says them in words', () => {
    expect(() => saveRules(db, [rule({ name: 'Gone', trigger: { kind: 'status', status_id: 'nope', when: 'enters' } })])).toThrow(/that status is gone/);
    expect(() => saveRules(db, [rule({ name: 'Bad', trigger: { kind: 'becomes_true', condition: 'has(' } })])).toThrow(/Bad: the condition/);
    expect(describeTrigger({ kind: 'tag_added', tag: 'Hot' })).toBe('When tag "Hot" is put on a lead');
    expect(describeTrigger({ kind: 'status', status_id: 's', when: 'leaves' }, undefined, () => 'Needs rebook')).toBe('When a lead leaves the status "Needs rebook"');
    expect(describeAction({ kind: 'counter', field_id: 'f', op: 'add', by: -1 }, () => 'Streak')).toBe('Take 1 off Streak');
    expect(describeAction({ kind: 'counter', field_id: 'f', op: 'set', by: 0 }, () => 'Streak')).toBe('Reset Streak to 0');
  });
});
