import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/http/app.js';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { addToCallList, getCallList, matchingLeadIds, toLeadFilter } from '../../src/server/domain/callList.js';
import { createCustomField, deleteCustomField, leadCustomValues, listCustomFields, setCustomValues, updateCustomField } from '../../src/server/domain/customFields.js';
import { previewFormula } from '../../src/server/domain/formulas.js';
import { tagLead } from '../../src/server/domain/tags.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { exportRows } from '../../src/server/domain/exporter.js';
import { runRule, saveRules } from '../../src/server/domain/rules.js';
import { listLeads } from '../../src/server/domain/leads.js';
import { LeadQuery } from '../../src/shared/leadFilter.js';
import { FormulaError, parseFormula, renameFormulaField } from '../../src/shared/formula.js';
import { describeFilter } from '../../src/shared/routines.js';
import { openDatabase, type DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: 'http://127.0.0.1:5170' };

let db: DB;
let file: string;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const value = (first: string, fieldId: string) => leadCustomValues(db, lead(first)).find((v) => v.field_id === fieldId)!.value;
const matching = (q: Record<string, unknown>) => matchingLeadIds(db, toLeadFilter(LeadQuery.parse(q)));
const formula = (label: string, f: string) => createCustomField(db, { label, type: 'formula', formula: f });

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  file = t.c.dbFile;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('the formula language', () => {
  it('reads formulas and says where a mistake is', () => {
    expect(parseFormula('1 + 2 * 3')).toEqual({ t: 'bin', op: '+', l: { t: 'num', v: 1 }, r: { t: 'bin', op: '*', l: { t: 'num', v: 2 }, r: { t: 'num', v: 3 } } });
    expect(parseFormula('IF(age >= 60, "old", “young”)')).toMatchObject({ t: 'call', name: 'if', args: [{ t: 'bin', op: '>=' }, { t: 'str', v: 'old' }, { t: 'str', v: 'young' }] });
    expect(parseFormula('not [Smoker?] and yes')).toMatchObject({ t: 'bin', op: 'and', l: { t: 'not', e: { t: 'field', label: 'Smoker?' } }, r: { t: 'bool', v: true } });
    const err = (src: string) => {
      try {
        parseFormula(src);
      } catch (e) {
        return [(e as FormulaError).message, (e as FormulaError).at];
      }
      return null;
    };
    expect(err('1 +')).toEqual(['the formula stops too soon', 3]);
    expect(err('(1 + 2')).toEqual(['expected a )', 6]);
    expect(err('age ; 1')).toEqual(['";" can\'t be used in a formula', 4]);
    expect(err('[Score')).toEqual(['a [field name] is missing its ]', 0]);
    expect(err('')).toEqual(['write a formula', null]);
  });

  it('carries a renamed field into a formula', () => {
    expect(renameFormulaField('[stage] + [Stage 2] + [ Stage ]', 'Stage', 'Step')).toBe('[Step] + [Stage 2] + [Step]');
  });
});

describe('formula fields', () => {
  it('a lead score: worked out for every lead, always up to date', () => {
    const score = formula('Score', 'if(age >= 60, 20, age >= 50, 10, 0) + if(has_tag("Hot"), 30, 0) - attempts * 2');
    expect(score).toMatchObject({ type: 'formula', result: 'number', leads: 0 });
    expect(value('Robert', score.id)).toBe('20');
    expect(value('Jane', score.id)).toBe('10');
    expect(value('Ann', score.id)).toBe('0');
    tagLead(db, lead('Ann'), 'hot');
    logManualCall(db, { lead_id: lead('Ann'), idempotency_key: `k-${uuidv7()}`, outcome_code: 'no_answer' });
    expect(value('Ann', score.id)).toBe('28');
  });

  it('reads your own fields, and numbers keep at most 2 places', () => {
    const pay = createCustomField(db, { label: 'Payment', type: 'money' });
    const smoker = createCustomField(db, { label: 'Smoker', type: 'yes_no' });
    const f = formula('Per day', 'ifblank([payment], 0) / 30');
    const g = formula('Ok', 'not ifblank([SMOKER], no) and loan_amount > 200000');
    expect(g.result).toBe('yes_no');
    setCustomValues(db, lead('Jane'), { [pay.id]: '1000', [smoker.id]: 'no' });
    expect(value('Jane', f.id)).toBe('33.33');
    expect(value('Ann', f.id)).toBe('0');
    expect(value('Jane', g.id)).toBe('yes');
    expect(value('Robert', g.id)).toBe('no');
    // A formula can use another one.
    const h = formula('Per week', '[Per day] * 7');
    expect(value('Jane', h.id)).toBe('233.33');
  });

  it('says what is wrong before saving', () => {
    createCustomField(db, { label: 'Stage', type: 'choice', options: ['Cold', 'Warm'] });
    expect(() => formula('A', 'age + "x"')).toThrow('A: "+" needs a number, not text');
    expect(() => formula('A', '[Nope] + 1')).toThrow('there is no field called [Nope]');
    expect(() => formula('A', 'agee')).toThrow('there is no value called "agee"');
    expect(() => formula('A', 'if(age, 1, 2)')).toThrow('each test in if() needs a yes/no');
    expect(() => formula('A', '[Stage] > 3')).toThrow("can't compare text with a number");
    expect(() => formula('A', '[A] + 1')).toThrow('[A] uses itself');
    expect(() => createCustomField(db, { label: 'A [1]', type: 'number' })).toThrow('[ or ]');
    const a = formula('A', '1');
    formula('B', '[A] + 1');
    expect(() => updateCustomField(db, a.id, { label: 'A', type: 'formula', formula: '[B] + 1' })).toThrow('uses itself');
  });

  it("can't be typed in, a field a formula uses can't go, and a rename carries over", () => {
    const n = createCustomField(db, { label: 'Kids', type: 'number' });
    const f = formula('Family', '[kids] + 2');
    expect(() => setCustomValues(db, lead('Jane'), { [f.id]: '5' })).toThrow('is worked out from its formula');
    expect(() => deleteCustomField(db, n.id)).toThrow('Family uses this field in a formula');
    expect(() => updateCustomField(db, n.id, { label: 'Kids', type: 'text' })).toThrow("its kind can't change");
    updateCustomField(db, n.id, { label: 'Children', type: 'number' });
    expect(listCustomFields(db).find((x) => x.id === f.id)!.formula).toBe('[Children] + 2');
    setCustomValues(db, lead('Jane'), { [n.id]: '3' });
    expect(value('Jane', f.id)).toBe('5');
    deleteCustomField(db, f.id);
    deleteCustomField(db, n.id);
    expect(listCustomFields(db)).toEqual([]);
  });

  it('filters by a range, sorts highest first, and the call list gets them in that order', () => {
    const age = formula('Age score', 'age');
    const ages = (ids: string[]) => ids.map((id) => db.prepare('SELECT age FROM lead WHERE id = ?').pluck().get(id));
    const over = ages(matching({ field_id: age.id, field_min: 50 }));
    expect(over).toContain(61);
    expect(over.every((a) => (a as number) >= 50)).toBe(true);
    expect(ages(matching({ field_id: age.id, field_min: 45, field_max: 52 })).every((a) => (a as number) >= 45 && (a as number) <= 52)).toBe(true);
    expect(matching({ field_id: age.id, field_value: '61' })).toEqual([lead('Robert')]);
    const sorted = matching({ sort_field: age.id });
    expect(ages(sorted)).toEqual([...ages(sorted)].sort((a, b) => (b == null ? -1 : a == null ? 1 : (b as number) - (a as number))));
    expect(sorted[0]).toBe(lead('Robert'));

    expect(listLeads(db, toLeadFilter(LeadQuery.parse({ sort_field: age.id }))).rows[0].id).toBe(lead('Robert'));
    addToCallList(db, sorted.slice(0, 2));
    expect(getCallList(db).map((i) => i.lead_id)).toEqual(sorted.slice(0, 2));
    expect(describeFilter({ field_id: age.id, field_min: 50, sort_field: age.id }, { field: () => 'Age score' })).toBe('All leads · Age score 50 or more · Highest Age score first');
  });

  it('works in rules and the export', () => {
    const score = formula('Score', 'age');
    const r = { id: 'r1', name: 'Tag the over-55s', enabled: true, trigger: { kind: 'manual' as const }, filter: { field_id: score.id, field_min: 55 }, actions: [{ kind: 'add_tag' as const, tag: 'Senior' }] };
    expect(runRule(db, r, 'manual')).toMatchObject({ matched: 1, results: [{ changed: 1 }] });
    expect(() => saveRules(db, [{ ...r, actions: [{ kind: 'set_field', field_id: score.id, value: '1' }] }])).toThrow("a rule can't set it");
    const robert = exportRows(db, 'leads').find((x: any) => x.first_name === 'Robert') as any;
    expect(JSON.parse(robert.custom_fields)).toEqual({ Score: 61 });
  });

  it('a formula with a mistake left in it is blank, not broken, and the view comes back when the app opens', () => {
    const f = formula('Score', 'age');
    db.prepare("UPDATE custom_field SET formula = 'age +' WHERE id = ?").run(f.id);
    db.close();
    db = openDatabase(file);
    expect(listCustomFields(db)[0]).toMatchObject({ result: null });
    expect(value('Robert', f.id)).toBeNull();
    db.prepare("UPDATE custom_field SET formula = 'age * 2' WHERE id = ?").run(f.id);
    db.close();
    db = openDatabase(file);
    expect(value('Robert', f.id)).toBe('122');
  });

  it('preview: what it gives your leads now, or the mistake', async () => {
    const p = previewFormula(db, 'age');
    expect(p).toMatchObject({ error: null, result: 'number', high: 61, low: 45 });
    expect(p.filled).toBe(p.total);
    expect(p.total).toBeGreaterThanOrEqual(4);
    expect(p.samples.length).toBeGreaterThan(0);
    expect(previewFormula(db, 'age +')).toMatchObject({ error: 'the formula stops too soon', at: 5 });
    const r = await app.inject({ method: 'POST', url: '/api/custom-fields/formula-preview', headers: write, payload: { formula: 'has_tag("x")' } });
    expect(r.json()).toMatchObject({ error: null, result: 'yes_no' });
    const c = await app.inject({ method: 'POST', url: '/api/custom-fields', headers: write, payload: { label: 'S', type: 'formula', formula: 'age' } });
    expect(c.json()).toMatchObject({ type: 'formula', formula: 'age', result: 'number' });
    const lr = await app.inject({ url: `/api/leads/${lead('Robert')}`, headers: auth });
    expect(lr.statusCode).toBe(200);
  });
});
