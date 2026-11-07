import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { tagLead } from '../../src/server/domain/tags.js';
import { listStatuses, saveStatuses } from '../../src/server/domain/statuses.js';
import { getLeadDetail, listLeads } from '../../src/server/domain/leads.js';
import { matchingLeadIds, toLeadFilter } from '../../src/server/domain/callList.js';
import { createCustomField } from '../../src/server/domain/customFields.js';
import { checkCondition } from '../../src/server/domain/formulas.js';
import { LeadQuery } from '../../src/shared/leadFilter.js';
import type { Status } from '../../src/shared/statuses.js';

let db: DB;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const st = (id: string, name: string, condition: string, more: Partial<Status> = {}): Status => ({ id, name, condition, color: 'blue', tab: false, ...more });

beforeEach(async () => {
  db = tempDb().db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
});

describe('statuses', () => {
  it('are named conditions: a lead can be in several, and one can use another', () => {
    const jane = lead('Jane');
    tagLead(db, jane, 'No show');
    tagLead(db, jane, 'Hot');
    const saved = saveStatuses(db, [
      st('a', 'Needs rebook', 'has("No show") and not has("Appt set")', { color: 'red', tab: true }),
      st('b', 'Hot rebook', 'status("Needs rebook") and has("Hot")', { color: 'orange' }),
      st('c', 'Everyone', 'True', { color: 'gray' }),
    ]);
    const total = (db.prepare('SELECT COUNT(*) n FROM lead').get() as { n: number }).n;
    expect(saved.map((x) => [x.name, x.leads, x.error])).toEqual([['Needs rebook', 1, null], ['Hot rebook', 1, null], ['Everyone', total, null]]);
    // Badges, in your order, on Leads and on the lead.
    const row = listLeads(db, toLeadFilter(LeadQuery.parse({ search: 'Jane' }))).rows[0]!;
    expect(row.statuses.map((x: { name: string }) => x.name)).toEqual(['Needs rebook', 'Hot rebook', 'Everyone']);
    expect(getLeadDetail(db, '', jane).statuses).toEqual([
      { id: 'a', name: 'Needs rebook', color: 'red' }, { id: 'b', name: 'Hot rebook', color: 'orange' }, { id: 'c', name: 'Everyone', color: 'gray' },
    ]);
    // The Leads tab, and status() in any condition.
    expect(matchingLeadIds(db, toLeadFilter(LeadQuery.parse({ in_status: 'b' })))).toEqual([jane]);
    expect(checkCondition(db, 'not status("hot rebook")')).toMatchObject({ error: null, matched: total - 1 });
    // A tag coming off moves the lead out by itself.
    tagLead(db, jane, 'Appt set');
    expect(listStatuses(db).map((x) => x.leads)).toEqual([0, 0, total]);
  });

  it('refuses a loop, a missing status, a repeated name and a mistake; a rename follows into other conditions', () => {
    expect(() => saveStatuses(db, [st('a', 'A', 'status("B")'), st('b', 'B', 'status("A")')])).toThrow(/uses itself/);
    expect(() => saveStatuses(db, [st('a', 'A', 'status("Nope")')])).toThrow(/A: there is no status called "Nope"/);
    expect(() => saveStatuses(db, [st('a', 'A', 'True'), st('b', 'a', 'True')])).toThrow(/two statuses are called/);
    expect(() => saveStatuses(db, [st('a', 'A', 'attempts +')])).toThrow(/A: /);
    expect(() => saveStatuses(db, [st('a', 'A', 'attempts')])).toThrow(/yes or no/);
    saveStatuses(db, [st('a', 'Needs rebook', 'has("No show")'), st('b', 'Hot', "status('needs rebook') and has(\"Hot\")")]);
    const after = saveStatuses(db, [st('a', 'Rebook', 'has("No show")'), st('b', 'Hot', "status('needs rebook') and has(\"Hot\")")]);
    expect(after[1]!.condition).toBe("status('Rebook') and has(\"Hot\")");
    expect(after[1]!.error).toBeNull();
  });

  it('status() is for conditions, not formula fields', () => {
    saveStatuses(db, [st('a', 'A', 'True')]);
    expect(() => createCustomField(db, { label: 'S', type: 'formula', formula: 'status("A")' })).toThrow(/not in formula fields/);
  });
});
