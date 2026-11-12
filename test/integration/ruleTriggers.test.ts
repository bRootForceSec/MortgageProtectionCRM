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
import { listRefill, loadRules, previewRule, routinesToRules, ruleRuns, runEventRules, runRule, runWaitingRules, saveRules, saveTagShortcuts } from '../../src/server/domain/rules.js';
import { addToCallList, clearWorked, getCallList } from '../../src/server/domain/callList.js';
import { rebuildLeadState } from '../../src/server/domain/leadState.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { setSetting } from '../../src/server/core/settings.js';
import { listLeads } from '../../src/server/domain/leads.js';
import { toLeadFilter } from '../../src/server/domain/callList.js';
import { checkCondition } from '../../src/server/domain/formulas.js';
import { LeadQuery } from '../../src/shared/leadFilter.js';
import { describeAction, describeTrigger, describeWait, type Rule } from '../../src/shared/rules.js';
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
    expect(describeTrigger({ kind: 'status', status_id: 's', when: 'leaves' }, undefined, () => 'Needs rebook')).toBe('When a lead leaves the smart list "Needs rebook"');
    expect(describeAction({ kind: 'counter', field_id: 'f', op: 'add', by: -1 }, () => 'Streak')).toBe('Take 1 off Streak');
    expect(describeAction({ kind: 'counter', field_id: 'f', op: 'set', by: 0 }, () => 'Streak')).toBe('Reset Streak to 0');
  });
});

describe('a wait in a rule', () => {
  it('holds the steps after it for each lead it reached, then does them when due; preview keeps nothing', () => {
    const jane = lead('Jane');
    const r = rule({ trigger: { kind: 'tag_added', tag: 'Hot' }, actions: [{ kind: 'add_tag', tag: 'Warm' }, { kind: 'wait', after: '2h' }, { kind: 'add_tag', tag: 'Call now' }, { kind: 'add_to_list' }] });
    saveRules(db, [r]);
    expect(previewRule(db, r).results.map((x) => x.action.kind)).toEqual(['add_tag', 'wait']);
    expect(db.prepare('SELECT COUNT(*) n FROM rule_wait').get()).toEqual({ n: 0 });

    tagLead(db, jane, 'Hot');
    runEventRules(db);
    expect(tags(jane)).toEqual(['Hot', 'Warm']);
    expect(db.prepare('SELECT lead_id, next_step FROM rule_wait').all()).toEqual([{ lead_id: jane, next_step: 2 }]);

    // Not due yet; then two hours on, the rest runs, logged as after a wait, even though she lost the tag meanwhile.
    expect(runWaitingRules(db, new Date(Date.now() + 60 * 60_000))).toEqual([]);
    untag(jane, 'Hot');
    const [run] = runWaitingRules(db, new Date(Date.now() + 2 * 60 * 60_000 + 60_000));
    expect(run).toMatchObject({ trigger: 'wait', matched: 1, error: null });
    expect(tags(jane)).toEqual(['Call now', 'Warm']);
    expect(getCallList(db).map((i) => i.lead_id)).toContain(jane);
    expect(db.prepare('SELECT COUNT(*) n FROM rule_wait').get()).toEqual({ n: 0 });
    expect(ruleRuns(db, { ruleId: r.id })[0]).toMatchObject({ trigger: 'wait' });
  });

  it('lets go of leads waiting on a rule switched off since, and refuses a wait with nothing after it', () => {
    const r = rule({ actions: [{ kind: 'wait', after: '15m' }, { kind: 'add_tag', tag: 'Later' }] });
    saveRules(db, [r]);
    runRule(db, loadRules(db)[0]!, 'manual');
    expect((db.prepare('SELECT COUNT(*) n FROM rule_wait').get() as { n: number }).n).toBeGreaterThan(0);
    saveRules(db, [{ ...r, enabled: false }]);
    expect(runWaitingRules(db, new Date(Date.now() + 20 * 60_000))).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM rule_wait').get()).toEqual({ n: 0 });
    expect(tags(lead('Jane'))).not.toContain('Later');
    expect(() => saveRules(db, [rule({ name: 'Ends waiting', actions: [{ kind: 'add_tag', tag: 'X' }, { kind: 'wait', after: '1d' }] })])).toThrow(/a wait needs a step after it/);
    expect(describeWait('2h')).toBe('2 hours');
    expect(describeWait('1d@09:00')).toBe('until 09:00 the next day');
    expect(describeAction({ kind: 'wait', after: '3d' })).toBe('Wait 3 days');
  });
});

describe('tag shortcuts', () => {
  /** Moves the times a tag was put on back by `hours`. */
  const age = (name: string, hours: number) =>
    db.prepare(`UPDATE lead_event SET at = strftime('%Y-%m-%dT%H:%M:%fZ', at, '-${hours} hours') WHERE tag_name = ?`).run(name);

  it('a tag that comes off by itself: after some hours, for leads tagged before the shortcut too', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    tagLead(db, jane, 'Called');
    age('Called', 30);
    tagLead(db, robert, 'Called');
    const called = ensureTag(db, 'Called').id;
    const { rules } = saveTagShortcuts(db, { expiry: [{ tag_id: called, hours: 24 }], groups: [] });
    expect(rules).toEqual([expect.objectContaining({
      id: `expiry:${called}`, name: 'Take "Called" off 1 day after it was put on',
      trigger: { kind: 'becomes_true', condition: 'has("Called") and hours_since(added("Called")) >= 24', already: true },
      actions: [{ kind: 'remove_tag', tag: 'Called' }],
    })]);
    runEventRules(db);
    expect(tags(jane)).toEqual([]);
    expect(tags(robert)).toEqual(['Called']);
    age('Called', 30);
    runEventRules(db);
    expect(tags(robert)).toEqual([]);
    // Put on again later: comes off again once it's old.
    tagLead(db, jane, 'Called');
    runEventRules(db);
    expect(tags(jane)).toEqual(['Called']);
    age('Called', 25);
    runEventRules(db);
    expect(tags(jane)).toEqual([]);
  });

  it('only one at a time: putting one on takes the others off; its rules follow a rename and are not yours to edit', () => {
    const jane = lead('Jane');
    const ids = ['No show', 'Sat', 'Sold'].map((n) => ensureTag(db, n).id);
    saveTagShortcuts(db, { expiry: [], groups: [{ id: 'g1', name: 'Appointment result', tag_ids: ids }] });
    runEventRules(db);
    tagLead(db, jane, 'No show');
    tagLead(db, jane, 'Hot');
    runEventRules(db);
    tagLead(db, jane, 'Sat');
    runEventRules(db);
    expect(tags(jane)).toEqual(['Hot', 'Sat']);
    db.prepare("UPDATE tag SET name = 'Showed' WHERE id = ?").run(ids[1]);
    expect(loadRules(db).map((r) => r.name)).toEqual([
      'Appointment result: "No show" takes the others off', 'Appointment result: "Showed" takes the others off', 'Appointment result: "Sold" takes the others off',
    ]);
    tagLead(db, jane, 'Sold');
    runEventRules(db);
    expect(tags(jane)).toEqual(['Hot', 'Sold']);
    // Saving Rules (with the shortcut rules sent back, even changed) keeps them as the shortcut writes them.
    const mine = rule({ name: 'Mine' });
    const sent = loadRules(db).map((r) => ({ ...r, enabled: false }));
    const saved = saveRules(db, [mine, ...sent]);
    expect(saved.map((r) => [r.name, r.enabled])).toEqual([['Mine', true], ...sent.map((r) => [r.name, true])]);
    expect(() => saveTagShortcuts(db, { expiry: [], groups: [{ id: 'g2', name: 'Bad', tag_ids: [ids[0], ids[0]] }] })).toThrow(/a tag is in it twice/);
  });

  it('when the call list runs out, the first rule in order that has leads to add fills it; a list with leads left does nothing', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    const ann = lead('Ann');
    tagLead(db, jane, 'First');
    tagLead(db, robert, 'Second');
    tagLead(db, ann, 'Third');
    runEventRules(db);
    addToCallList(db, [jane]);
    saveRules(db, [
      rule({ name: 'Then nobody', trigger: { kind: 'list_empty' }, filter: { tag: ensureTag(db, 'Nobody').id } }),
      rule({ name: 'Then second', trigger: { kind: 'list_empty' }, filter: { tag: ensureTag(db, 'Second').id } }),
      rule({ name: 'Then third', trigger: { kind: 'list_empty' }, filter: { tag: ensureTag(db, 'Third').id } }),
      rule({ name: 'Then first', trigger: { kind: 'list_empty' }, filter: { tag: ensureTag(db, 'First').id } }),
    ]);
    // Jane is still to call: the list hasn't run out.
    expect(runEventRules(db)).toEqual([]);
    logManualCall(db, { lead_id: jane, idempotency_key: uuidv7(), outcome_code: 'no_answer' });
    // Jane called: the list ran out. "Then nobody" has no one, so "Then second" fills it, and "Then third" waits.
    expect(runEventRules(db).map((r) => r.rule_name)).toEqual(['Then second']);
    expect(getCallList(db).map((i) => i.lead_id)).toEqual([jane, robert]);
    expect(ruleRuns(db).map((r) => r.rule_name)).toEqual(['Then second']);
    logManualCall(db, { lead_id: robert, idempotency_key: uuidv7(), outcome_code: 'no_answer' });
    expect(runEventRules(db).map((r) => r.rule_name)).toEqual(['Then third']);
    logManualCall(db, { lead_id: ann, idempotency_key: uuidv7(), outcome_code: 'no_answer' });
    // Everyone is called from the list, and no rule waits between dials, so nobody you just called comes straight back.
    expect(runEventRules(db)).toEqual([]);
    expect(listRefill(db)).toEqual({ rules: 4, next: null });
    // Clear worked leads: an empty list has run out too, and the rules fill it again.
    clearWorked(db);
    expect(runEventRules(db).map((r) => r.rule_name)).toEqual(['Then second']);
    expect(getCallList(db).map((i) => i.lead_id)).toEqual([robert]);
    expect(listRefill(db)).toBeNull();
    expect(describeTrigger({ kind: 'list_empty' })).toBe('When the call list runs out (the first of these rules that adds leads wins)');
  });

  it("today's imports, then today's no-answers once the hour is up: called leads come back onto the list, and the wait is told", () => {
    const all = (db.prepare('SELECT id FROM lead').all() as { id: string }[]).map((r) => r.id);
    saveRules(db, [
      rule({ name: "Then today's imports", trigger: { kind: 'list_empty' }, filter: { status: 'new', imported: 'today' } }),
      rule({ name: "Then today's no-answers", trigger: { kind: 'list_empty' }, filter: { status: 'no_answer', not_within_min: 60 } }),
    ]);
    // The list is empty, so it has run out: today's imports go on.
    expect(runEventRules(db).map((r) => r.rule_name)).toEqual(["Then today's imports"]);
    const imported = getCallList(db).map((i) => i.lead_id);
    expect(imported.length).toBeGreaterThan(1);
    for (const id of imported) logManualCall(db, { lead_id: id, idempotency_key: uuidv7(), outcome_code: 'no_answer' });
    // All called, all no answer: none is ready before the hour is up, and the Calling screen is told when they will be.
    expect(runEventRules(db)).toEqual([]);
    const refill = listRefill(db)!;
    expect(refill.next).toMatchObject({ rule_name: "Then today's no-answers", leads: imported.length });
    const firstCall = (db.prepare('SELECT min(requested_at) at FROM call').get() as { at: string }).at;
    expect(Date.parse(refill.next!.ready_at)).toBe(Date.parse(firstCall) + 60 * 60_000);
    // An hour on, they come back onto the list (they're on it already, as called) to call again.
    const back = (col: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${col}, '-61 minutes')`;
    db.prepare(`UPDATE call SET requested_at = ${back('requested_at')}`).run();
    db.prepare(`UPDATE call_list_item SET added_at = ${back('added_at')}`).run();
    rebuildLeadState(db, all);
    expect(runEventRules(db).map((r) => r.rule_name)).toEqual(["Then today's no-answers"]);
    expect(getCallList(db).filter((i) => !i.done).map((i) => i.lead_id).sort()).toEqual([...imported].sort());
    expect(listRefill(db)).toBeNull();
  });

  it('once, the steps of your routines become "when the call list runs out" rules, in order and switched on', () => {
    setSetting(db, 'routines', [
      { id: 'r1', name: 'Every day', days: [1], steps: [
        { id: 's1', name: 'No-shows', order: 'best_time', source: { kind: 'filter', filter: { status: 'appt_no_show', appt_days: 'since_last_calling_day' } } },
        { id: 's2', name: 'Friday list', order: 'set', source: { kind: 'saved_list', list_id: 'x' } },
        { id: 's3', name: "Today's imports", order: 'set', source: { kind: 'filter', filter: { status: 'new', imported: 'today' } } },
      ] },
      { id: 'r2', name: 'Weekend', days: [0], steps: [{ id: 's4', name: 'No-shows', order: 'set', source: { kind: 'filter', filter: { status: 'appt_no_show' } } }] },
    ]);
    expect(routinesToRules(db)).toBe(2);
    expect(routinesToRules(db)).toBe(0);
    expect(loadRules(db).map((r) => [r.name, r.enabled, r.trigger.kind, r.filter])).toEqual([
      ['Then No-shows', true, 'list_empty', { status: 'appt_no_show', appt_days: 'since_last_calling_day' }],
      ["Then Today's imports", true, 'list_empty', { status: 'new', imported: 'today' }],
    ]);
  });
});

describe('when leads are imported', () => {
  it('tags each new lead by its details, once, and leaves leads already there alone', async () => {
    saveRules(db, [rule({ name: 'Over 60', trigger: { kind: 'imported' }, filter: { where: 'age >= 60' }, actions: [{ kind: 'add_tag', tag: 'Over 60' }] })]);
    expect(runEventRules(db)).toEqual([]); // Robert (61) was imported before the rule
    expect(tags(lead('Robert'))).toEqual([]);

    const rows = [
      ['Mary Old', '(614) 555-0201', 'Chase', 150000, 70, '', '1 A St', 'Columbus', 'OH', '43215', '', '', '', '', '', ''],
      ['Tom Young', '(614) 555-0202', 'Chase', 150000, 35, '', '2 B St', 'Columbus', 'OH', '43215', '', '', '', '', '', ''],
    ];
    const parsed = await parseSpreadsheet(sampleCsv(rows), 'b.csv');
    commitImport(db, parsed, parsed.sheets[0]!, suggestMapping(parsed.sheets[0]!.headers), { name: 'b2' });
    const runs = runEventRules(db);
    expect(runs.map((r) => [r.rule_name, r.trigger, r.matched])).toEqual([['Over 60', 'imported', 1]]);
    expect(tags(lead('Mary'))).toEqual(['Over 60']);
    expect(tags(lead('Tom'))).toEqual([]);
    expect(runEventRules(db)).toEqual([]);
    expect(describeTrigger({ kind: 'imported' })).toBe('When a new lead is imported');
  });
});

