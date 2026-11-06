import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { addToCallList, getCallList } from '../../src/server/domain/callList.js';
import { recordUnitrustEvents, type UnitrustEvent } from '../../src/server/domain/unitrustAppointments.js';
import { rebuildLeadState } from '../../src/server/domain/leadState.js';
import { loadRules, previewRule, ruleRuns, runCallRules, runDueDailyRules, runRule, runRuleById, saveRules } from '../../src/server/domain/rules.js';
import { createCustomField, leadCustomValues } from '../../src/server/domain/customFields.js';
import { leadTags } from '../../src/server/domain/tags.js';
import { STARTER_RULES, describeAction, describeTrigger, type Rule } from '../../src/shared/rules.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const id = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const key = () => `k-${uuidv7()}`;
const day = (back: number) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const ev = (color: UnitrustEvent['color'], date: string): UnitrustEvent => ({ title: 'OH - ROCKET MORTG - ROBERT RAY- (614) 555-0102 RAY', date, time: '10:00', color });
const listed = () => getCallList(db).map((i) => i.lead_id);
const rule = (over: Partial<Rule>): Rule => ({ id: uuidv7(), name: 'Test', enabled: true, trigger: { kind: 'manual' }, filter: {}, actions: [{ kind: 'add_to_list' }], ...over });
const starter = (i: number): Rule => ({ ...STARTER_RULES[i]!, id: `starter-${i}`, enabled: true });

/** Robert booked 4 days ago, and a no-show (red in Unitrust) `back` days ago. */
const noShow = (back: number) => {
  logManualCall(db, { lead_id: id('Robert'), idempotency_key: key(), outcome_code: 'appointment' });
  db.prepare(`UPDATE call SET requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', requested_at, '-4 days')`).run();
  rebuildLeadState(db);
  recordUnitrustEvents(db, [ev('red', day(back))], { today: day(0) });
};

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('rules', () => {
  it("the no-show example: yesterday's no-shows go on the list; two days on, still waiting, they come off", () => {
    noShow(1);
    const robert = id('Robert');
    const on = runRule(db, starter(0), 'daily');
    expect(on).toMatchObject({ matched: 1, error: null, results: [{ changed: 1 }] });
    expect(listed()).toEqual([robert]);
    // The second rule only takes leads whose no-show was 2 days ago.
    expect(runRule(db, starter(1), 'daily').matched).toBe(0);

    // A day later: the no-show is 2 days ago and Robert wasn't called, so he comes off.
    db.prepare("UPDATE appointment SET scheduled_for = ? || substr(scheduled_for, 11) WHERE recorded_via = 'unitrust'").run(day(2));
    db.prepare(`UPDATE call_list_item SET added_at = strftime('%Y-%m-%dT%H:%M:%fZ', added_at, '-1 day')`).run();
    const off = runRule(db, starter(1), 'daily');
    expect(off).toMatchObject({ matched: 1, results: [{ changed: 1 }] });
    expect(listed()).toEqual([]);
  });

  it('preview says what a run would do and changes nothing', () => {
    noShow(1);
    const p = previewRule(db, starter(0));
    expect(p).toMatchObject({ dry_run: true, matched: 1, results: [{ changed: 1 }], leads: [{ name: 'Robert Ray' }] });
    expect(listed()).toEqual([]);
    expect(ruleRuns(db, { all: true })).toEqual([]);
  });

  it('a daily rule runs once a day, after its time, on its days, and only when switched on', () => {
    noShow(1);
    const r = starter(0);
    const eight = new Date();
    eight.setHours(8, 30, 0, 0);
    const seven = new Date(eight);
    seven.setHours(7, 59);
    saveRules(db, [r, { ...starter(1), enabled: false }]);
    expect(runDueDailyRules(db, seven)).toEqual([]);
    expect(runDueDailyRules(db, eight).map((x) => x.rule_name)).toEqual([r.name]);
    expect(runDueDailyRules(db, eight)).toEqual([]);
    expect(ruleRuns(db)).toHaveLength(1);
    saveRules(db, [{ ...r, id: 'other', trigger: { kind: 'daily', time: '08:00', days: [(eight.getDay() + 1) % 7] } }]);
    expect(runDueDailyRules(db, eight)).toEqual([]);
  });

  it('when a call is saved with an outcome: tags and sets a field on that lead only', async () => {
    const f = createCustomField(db, { label: 'Stage', type: 'choice', options: ['Cold', 'Warm'] });
    saveRules(db, [rule({ trigger: { kind: 'call_saved', outcomes: ['no_appt'] }, actions: [{ kind: 'add_tag', tag: 'Talked' }, { kind: 'set_field', field_id: f.id, value: 'warm' }] })]);
    const jane = id('Jane');
    const ann = id('Ann');
    const r = await app.inject({ method: 'POST', url: `/api/leads/${jane}/calls`, headers: write, payload: { idempotency_key: key(), outcome_code: 'no_appt' } });
    expect(r.statusCode).toBe(200);
    expect(leadTags(db, jane).map((t) => t.name)).toEqual(['Talked']);
    expect(leadCustomValues(db, jane)[0]!.value).toBe('Warm');
    expect(leadTags(db, ann)).toEqual([]);
    const other = logManualCall(db, { lead_id: ann, idempotency_key: key(), outcome_code: 'no_answer' });
    expect(runCallRules(db, other.call_id)).toEqual([]);
    const [run] = ruleRuns(db);
    expect(run).toMatchObject({ trigger: 'call_saved', matched: 1, leads: [{ id: jane }] });
  });

  it('a failing action changes nothing and the log says why; saving checks fields and outcomes', () => {
    const r = rule({ actions: [{ kind: 'add_to_list' }, { kind: 'set_field', field_id: 'gone', value: 'x' }] });
    const run = runRule(db, r, 'manual');
    expect(run.error).toBe('that field is gone');
    expect(listed()).toEqual([]);
    expect(ruleRuns(db)[0]!.error).toBe('that field is gone');
    expect(() => saveRules(db, [r])).toThrow(/field is gone/);
    expect(() => saveRules(db, [rule({ trigger: { kind: 'call_saved', outcomes: ['nope'] } })])).toThrow(/unknown outcome/);
    expect(() => saveRules(db, [rule({ actions: [] })])).toThrow();
  });

  it('mark dead skips leads already there; Run now by id', () => {
    const r = rule({ filter: { search: 'Jane' }, actions: [{ kind: 'mark_dead' }] });
    saveRules(db, [r]);
    expect(runRuleById(db, r.id, false).results[0]).toMatchObject({ changed: 1 });
    expect(runRuleById(db, r.id, false).results[0]).toMatchObject({ changed: 0, note: '1 already in it' });
    expect(db.prepare("SELECT reason FROM lead_action WHERE action = 'mark_dead'").all()).toEqual([{ reason: 'Rule: Test' }]);
    expect(loadRules(db)).toHaveLength(1);
  });

  it('remove from list and remove tag', () => {
    const jane = id('Jane');
    addToCallList(db, [jane]);
    const run = runRule(db, rule({ filter: { on_list: '1' }, actions: [{ kind: 'remove_from_list' }, { kind: 'remove_tag', tag: 'Nope' }] }), 'manual');
    expect(run.results).toEqual([
      { action: { kind: 'remove_from_list' }, changed: 1, note: null },
      { action: { kind: 'remove_tag', tag: 'Nope' }, changed: 0, note: 'no tag called "Nope"' },
    ]);
  });

  it('describes triggers and actions in words', () => {
    expect(describeTrigger({ kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] })).toBe('At 08:00 on Mon–Fri');
    expect(describeTrigger({ kind: 'call_saved', outcomes: ['no_show'] }, () => 'Appt: No show')).toBe('When a call is saved as Appt: No show');
    expect(describeAction({ kind: 'set_field', field_id: 'f', value: '' }, () => 'Stage')).toBe('Clear Stage');
  });

  it('routes: save, preview, run, log', async () => {
    const r = rule({ filter: { search: 'Ann' } });
    expect((await app.inject({ method: 'PUT', url: '/api/rules', headers: write, payload: { rules: [r] } })).statusCode).toBe(200);
    const p = await app.inject({ method: 'POST', url: '/api/rules/preview', headers: write, payload: { rule: r } });
    expect(p.json()).toMatchObject({ dry_run: true, matched: 1 });
    const run = await app.inject({ method: 'POST', url: `/api/rules/${r.id}/run`, headers: write, payload: {} });
    expect(run.json()).toMatchObject({ dry_run: false, results: [{ changed: 1 }] });
    expect((await app.inject({ url: '/api/rules/runs', headers: auth })).json().runs).toHaveLength(1);
    expect((await app.inject({ url: '/api/rules', headers: auth })).json().rules[0].id).toBe(r.id);
  });
});
