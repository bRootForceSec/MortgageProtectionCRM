import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv, SAMPLE_ROWS } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { tagLead } from '../../src/server/domain/tags.js';
import { listStatuses, loadStatuses, saveStatuses } from '../../src/server/domain/statuses.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { LEAD_TABS } from '../../src/shared/leadStatus.js';
import { uuidv7 } from '../../src/server/ids.js';
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
    expect(checkCondition(db, 'not in_list("hot rebook")')).toMatchObject({ error: null, matched: total - 1 });
    // A tag coming off moves the lead out by itself.
    tagLead(db, jane, 'Appt set');
    expect(listStatuses(db).map((x) => x.leads)).toEqual([0, 0, total]);
  });

  it('refuses a loop, a missing status, a repeated name and a mistake; a rename follows into other conditions', () => {
    expect(() => saveStatuses(db, [st('a', 'A', 'status("B")'), st('b', 'B', 'status("A")')])).toThrow(/uses itself/);
    expect(() => saveStatuses(db, [st('a', 'A', 'status("Nope")')])).toThrow(/A: there is no smart list called "Nope"/);
    expect(() => saveStatuses(db, [st('a', 'A', 'True'), st('b', 'a', 'True')])).toThrow(/two smart lists are called/);
    expect(() => saveStatuses(db, [st('a', 'A', 'attempts +')])).toThrow(/A: /);
    expect(() => saveStatuses(db, [st('a', 'A', 'attempts')])).toThrow(/yes or no/);
    saveStatuses(db, [st('a', 'Needs rebook', 'has("No show")'), st('b', 'Hot', "status('needs rebook') and has(\"Hot\")")]);
    const after = saveStatuses(db, [st('a', 'Rebook', 'has("No show")'), st('b', 'Hot', "status('needs rebook') and has(\"Hot\")")]);
    expect(after[1]!.condition).toBe("status('Rebook') and has(\"Hot\")");
    expect(after[1]!.error).toBeNull();
    // in_list() follows a rename too.
    const again = saveStatuses(db, [st('a', 'No-show rebook', 'has("No show")'), st('b', 'Hot', 'in_list("Rebook") and has("Hot")')]);
    expect(again[1]!.condition).toBe('in_list("No-show rebook") and has("Hot")');
  });

  it('status() is for conditions, not formula fields', () => {
    saveStatuses(db, [st('a', 'A', 'True')]);
    expect(() => createCustomField(db, { label: 'S', type: 'formula', formula: 'status("A")' })).toThrow(/not in formula fields/);
  });

  it('the starter lists pick the same leads as the old fixed Leads tabs', async () => {
    // More leads, each called its own way.
    const rows = Array.from({ length: 12 }, (_, i) => [`P${i} Test`, `(614) 555-02${String(i).padStart(2, '0')}`, ...SAMPLE_ROWS[0]!.slice(2)]);
    const parsed = await parseSpreadsheet(sampleCsv(rows), 'b.csv');
    const sheet = parsed.sheets[0]!;
    commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b2' });
    const plans: string[][] = [
      [],
      ['no_answer'],
      ['no_appt'],
      ['appointment'],
      ['appointment', 'appt_no_show'],
      ['appointment', 'appt_sat_no_sale'],
      ['appointment', 'appt_prezi'],
      ['appointment', 'appt_sale'],
      ['appointment', 'appt_rescheduled'],
      ['bad_number'],
      ['callback'],
      ['no_appt!'],
    ];
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    plans.forEach((plan, i) => {
      for (const code of plan) {
        logManualCall(db, { lead_id: lead(`P${i}`), idempotency_key: uuidv7(), outcome_code: code.replace('!', ''), do_not_call: code.endsWith('!'), ...(code === 'callback' ? { callback_due_at: tomorrow } : {}) });
      }
    });
    const lists = loadStatuses(db);
    const ids = (q: Record<string, string>) => listLeads(db, toLeadFilter(LeadQuery.parse({ ...q, limit: 500 }))).rows.map((r) => r.id).sort();
    let checked = 0;
    for (const tab of LEAD_TABS) {
      if (tab.key === 'all') continue;
      const list = lists.find((x) => x.name === tab.label);
      expect(list, tab.label).toBeDefined();
      expect(ids({ in_status: list!.id }), tab.label).toEqual(ids({ status: tab.key }));
      if (ids({ status: tab.key }).length) checked++;
    }
    expect(checked).toBe(LEAD_TABS.length - 1); // and every tab has someone in it
  });
});
