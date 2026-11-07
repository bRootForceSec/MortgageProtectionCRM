import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/http/app.js';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { matchingLeadIds, toLeadFilter } from '../../src/server/domain/callList.js';
import { createCustomField, deleteCustomField, leadCustomValues, listCustomFields, moveCustomField, setCustomValues, updateCustomField } from '../../src/server/domain/customFields.js';
import { exportRows } from '../../src/server/domain/exporter.js';
import { LeadQuery } from '../../src/shared/leadFilter.js';
import { normalizeCustomValue, showCustomValue } from '../../src/shared/customFields.js';
import { describeFilter } from '../../src/shared/leadFilter.js';
import type { DB } from '../../src/server/db/connection.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const matching = (q: Record<string, unknown>) => matchingLeadIds(db, toLeadFilter(LeadQuery.parse(q)));

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('custom field values', () => {
  const f = (type: Parameters<typeof normalizeCustomValue>[0]['type'], options: string[] = []) => ({ label: 'X', type, options });
  it('keeps each kind in one form, and says what is wrong', () => {
    expect(normalizeCustomValue(f('money'), '$1,250.5')).toBe('1250.50');
    expect(normalizeCustomValue(f('number'), ' 3 ')).toBe('3');
    expect(normalizeCustomValue(f('date'), '11/6/2026')).toBe('2026-11-06');
    expect(normalizeCustomValue(f('date'), '2026-11-06')).toBe('2026-11-06');
    expect(normalizeCustomValue(f('yes_no'), 'Y')).toBe('yes');
    expect(normalizeCustomValue(f('choice', ['Husband', 'Wife']), 'wife')).toBe('Wife');
    expect(normalizeCustomValue(f('text'), '   ')).toBeNull();
    expect(() => normalizeCustomValue(f('number'), 'lots')).toThrow('X: needs a number');
    expect(() => normalizeCustomValue(f('date'), '2/30/2026')).toThrow(/does not exist/);
    expect(() => normalizeCustomValue(f('choice', ['A']), 'B')).toThrow(/pick one of A/);
    expect(showCustomValue({ type: 'money' }, '1250.50')).toBe('$1,250.50');
    expect(showCustomValue({ type: 'date' }, '2026-11-06')).toBe('11/6/2026');
  });
});

describe('custom fields', () => {
  it('defines fields in order, refuses a clash, and keeps the kind once leads have values', () => {
    const pay = createCustomField(db, { label: 'Mortgage payment', type: 'money' });
    const who = createCustomField(db, { label: 'Who decides', type: 'choice', options: ['Husband', 'Wife', 'husband', 'Both'] });
    expect(who.options).toEqual(['Husband', 'Wife', 'Both']);
    expect(() => createCustomField(db, { label: 'mortgage PAYMENT', type: 'text' })).toThrow(/already a field/);
    expect(() => createCustomField(db, { label: 'Empty list', type: 'choice', options: [] })).toThrow(/at least one choice/);
    expect(listCustomFields(db).map((x) => x.label)).toEqual(['Mortgage payment', 'Who decides']);
    expect(moveCustomField(db, who.id, -1).map((x) => x.label)).toEqual(['Who decides', 'Mortgage payment']);

    const jane = lead('Jane');
    expect(setCustomValues(db, jane, { [pay.id]: '1,800' })).toBe(1);
    expect(() => updateCustomField(db, pay.id, { label: 'Mortgage payment', type: 'text' })).toThrow(/can't change/);
    expect(updateCustomField(db, pay.id, { label: 'Monthly payment', type: 'money' }).label).toBe('Monthly payment');
  });

  it('values on a lead: kept in the change history, cleared by blank, filtered on, exported, gone with the field', () => {
    const pay = createCustomField(db, { label: 'Payment', type: 'money' });
    const sp = createCustomField(db, { label: 'Spouse', type: 'text' });
    const jane = lead('Jane');
    const ann = lead('Ann');
    setCustomValues(db, jane, { [pay.id]: '$1800', [sp.id]: 'Mark' });
    setCustomValues(db, ann, { [sp.id]: 'mark' });
    expect(leadCustomValues(db, jane).map((v) => v.value)).toEqual(['1800.00', 'Mark']);
    expect(db.prepare("SELECT field, old_value, new_value FROM lead_change WHERE lead_id = ? AND field = 'Payment'").all(jane)).toEqual([{ field: 'Payment', old_value: null, new_value: '1800.00' }]);
    expect(setCustomValues(db, jane, { [pay.id]: '1800' })).toBe(0);
    expect(() => setCustomValues(db, jane, { [pay.id]: 'lots' })).toThrow('Payment: needs a number');

    expect(matching({ field_id: pay.id })).toEqual([jane]);
    expect(matching({ field_id: sp.id, field_value: 'MARK' }).sort()).toEqual([jane, ann].sort());
    expect(matching({ field_id: sp.id, field_value: 'Bob' })).toEqual([]);
    expect(describeFilter({ status: 'all', field_id: sp.id, field_value: 'Mark' }, { field: () => 'Spouse' })).toBe('All leads · Spouse is "Mark"');

    const row = exportRows(db, 'leads').find((r) => r.id === jane)!;
    expect(JSON.parse(row.custom_fields as string)).toEqual({ Payment: '1800.00', Spouse: 'Mark' });

    setCustomValues(db, jane, { [pay.id]: '' });
    expect(matching({ field_id: pay.id })).toEqual([]);
    expect(deleteCustomField(db, sp.id)).toEqual({ removed_from: 2 });
    expect(leadCustomValues(db, jane).map((v) => v.label)).toEqual(['Payment']);
  });

  it('routes: define a field, set it with the lead edit, see it on the lead', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/custom-fields', headers: write, payload: { label: 'Smoker?', type: 'yes_no' } });
    expect(r.statusCode).toBe(200);
    const field = r.json();
    const jane = lead('Jane');
    const bad = await app.inject({ method: 'PATCH', url: `/api/leads/${jane}`, headers: write, payload: { custom: { [field.id]: 'maybe' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('Smoker?: needs yes or no');
    expect((await app.inject({ method: 'PATCH', url: `/api/leads/${jane}`, headers: write, payload: { custom: { [field.id]: 'no' } } })).statusCode).toBe(200);
    const d = (await app.inject({ url: `/api/leads/${jane}`, headers: auth })).json();
    expect(d.custom).toEqual([{ field_id: field.id, label: 'Smoker?', result: null, type: 'yes_no', options: [], value: 'no', shown: true, required: false }]);
    expect((await app.inject({ url: `/api/leads?field_id=${field.id}&field_value=no`, headers: auth })).json().total).toBe(1);
    expect((await app.inject({ url: '/api/custom-fields', headers: auth })).json()[0]).toMatchObject({ label: 'Smoker?', leads: 1 });
  });
});
