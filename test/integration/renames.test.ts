import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { ensureTag, leadTags, renameTag, setTagOnLeads } from '../../src/server/domain/tags.js';
import { createCustomField, listCustomFields, updateCustomField } from '../../src/server/domain/customFields.js';
import { loadButtons, plainButtonNames, saveButtons } from '../../src/server/domain/buttons.js';
import { saveStatuses } from '../../src/server/domain/statuses.js';
import { loadStatusDefs } from '../../src/server/domain/formulas.js';
import { getSetting, setSetting } from '../../src/server/core/settings.js';
import { ButtonDef } from '../../src/shared/buttons.js';
import { renameNameIn } from '../../src/shared/formula.js';

// A rename carries into every formula and condition you've saved: smart lists, buttons, rules, funnel steps, who can
// be called, your order and your fields.

let db: DB;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;

beforeEach(async () => {
  db = tempDb().db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
});

describe('renames', () => {
  it('rewrite a name in the functions that use it, any case, either quotes, and leave the rest', () => {
    const src = `has("Hot") and before('hot', "Cold") and times("Hotter", days=7) > 1 and pressed("Hot") and [Hot] > 1 # has("Hot")`;
    expect(renameNameIn(src, ['has', 'before', 'times'], 'Hot', 'Warm')).toBe(
      `has("Warm") and before('Warm', "Cold") and times("Hotter", days=7) > 1 and pressed("Hot") and [Hot] > 1 # has("Warm")`,
    );
  });

  it('a renamed tag carries into every condition and a funnel step counting it', () => {
    const t = ensureTag(db, 'Hot');
    saveStatuses(db, [{ id: 'a', name: 'Hot ones', condition: 'has("Hot")', color: 'red', tab: false }]);
    setSetting(db, 'funnel_steps', [{ id: 's', label: 'Hot', count: { by: 'tag', tag: 'Hot' } }, { id: 'f', label: 'F', count: { by: 'formula', formula: 'times("hot")' } }]);
    setSetting(db, 'rules', [{ filter: { where: 'not has("Hot")' }, trigger: { kind: 'becomes_true', condition: 'added("Hot") > 0' } }]);
    setSetting(db, 'calling', { callable_when: 'has("Hot") or True', list_order: [{ formula: 'times("Hot")' }] });
    const f = createCustomField(db, { label: 'Heat', type: 'formula', formula: 'times("Hot")' });
    createCustomField(db, { label: 'Notes2', type: 'text', show_when: 'has("Hot")' });

    renameTag(db, t.id, 'Warm');
    expect(loadStatusDefs(db)[0]!.condition).toBe('has("Warm")');
    expect(getSetting(db, 'funnel_steps')).toEqual([{ id: 's', label: 'Hot', count: { by: 'tag', tag: 'Warm' } }, { id: 'f', label: 'F', count: { by: 'formula', formula: 'times("Warm")' } }]);
    expect(getSetting(db, 'rules')).toEqual([{ filter: { where: 'not has("Warm")' }, trigger: { kind: 'becomes_true', condition: 'added("Warm") > 0' } }]);
    expect(getSetting(db, 'calling')).toEqual({ callable_when: 'has("Warm") or True', list_order: [{ formula: 'times("Warm")' }] });
    const fields = listCustomFields(db);
    expect(fields.find((x) => x.id === f.id)!.formula).toBe('times("Warm")');
    expect(fields.find((x) => x.label === 'Notes2')!.show_when).toBe('has("Warm")');
  });

  it('a renamed smart list and a renamed field carry outside smart lists too', () => {
    saveStatuses(db, [{ id: 'a', name: 'Rebook', condition: 'True', color: 'red', tab: false }]);
    setSetting(db, 'funnel_steps', [{ id: 's', label: 'R', count: { by: 'list', list: 'Rebook' } }]);
    setSetting(db, 'calling', { callable_when: 'not in_list("Rebook")' });
    saveStatuses(db, [{ id: 'a', name: 'Needs rebook', condition: 'True', color: 'red', tab: false }]);
    expect(getSetting(db, 'funnel_steps')).toEqual([{ id: 's', label: 'R', count: { by: 'list', list: 'Needs rebook' } }]);
    expect(getSetting(db, 'calling')).toEqual({ callable_when: 'not in_list("Needs rebook")' });

    const score = createCustomField(db, { label: 'Score', type: 'number' });
    saveStatuses(db, [{ id: 'a', name: 'Needs rebook', condition: '[Score] > 3', color: 'red', tab: false }]);
    updateCustomField(db, score.id, { label: 'Lead score', type: 'number' });
    expect(loadStatusDefs(db)[0]!.condition).toBe('[Lead score] > 3');
  });

  it("a renamed button takes its own tag and pressed() with it", () => {
    const jane = lead('Jane');
    const b = loadButtons(db).find((x) => x.id === 'no_answer')!;
    setTagOnLeads(db, [jane], ensureTag(db, b.label).id, true);
    saveStatuses(db, [...loadStatusDefs(db), { id: 'a', name: 'NA', condition: `has("${b.label}") or pressed("${b.label}") > 2`, color: 'gray', tab: false }]);
    saveButtons(db, loadButtons(db).map((x) => ButtonDef.parse(x.id === 'no_answer' ? { ...x, label: 'Nobody home' } : x)));
    expect(leadTags(db, jane).map((t) => t.name)).toEqual(['Nobody home']);
    expect(loadStatusDefs(db).find((x) => x.id === 'a')!.condition).toBe('has("Nobody home") or pressed("Nobody home") > 2');
  });

  it('once: buttons named with "Dial:" and "Appt:" take their plain names, with their tags and conditions', () => {
    const jane = lead('Jane');
    setSetting(db, 'plain_names_done', false);
    setTagOnLeads(db, [jane], ensureTag(db, 'Dial: No answer').id, true);
    ensureTag(db, 'Appt: No show');
    saveStatuses(db, [{ id: 'a', name: 'NA', condition: 'has("Dial: No answer") and not has("Appt: No show") and pressed("Dial: Appt set") = 0', color: 'gray', tab: false }]);
    expect(plainButtonNames(db)).toBe(true);
    expect(leadTags(db, jane).map((t) => t.name)).toEqual(['No answer']);
    expect(loadStatusDefs(db)[0]!.condition).toBe('has("No answer") and not has("No show") and pressed("Appt set") = 0');
    expect(plainButtonNames(db)).toBe(false);
  });
});
