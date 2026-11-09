import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { ensureTag, leadEvents, leadTags, tagLead } from '../../src/server/domain/tags.js';
import { createCustomField, leadCustomValues, updateCustomField } from '../../src/server/domain/customFields.js';
import { buttonsHiddenFor, loadButtons, saveButtons, sidesToConditions, tagLeadsWithLastButton } from '../../src/server/domain/buttons.js';
import { changeOutcome, logManualCall, voidCall } from '../../src/server/domain/calls.js';
import { loadOutcomeOverrides } from '../../src/server/domain/callingSettings.js';
import { checkCondition, loadStatusDefs } from '../../src/server/domain/formulas.js';
import { runEventRules, saveRules } from '../../src/server/domain/rules.js';
import { buildReport } from '../../src/server/domain/reports.js';
import { OUTCOMES } from '../../src/shared/outcomes.js';
import { ButtonDef, starterShowWhen } from '../../src/shared/buttons.js';
import { buildApp } from '../../src/server/http/app.js';
import { uuidv7 } from '../../src/server/ids.js';
import { setSetting } from '../../src/server/core/settings.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const write = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const tags = (id: string) => leadTags(db, id).map((t) => t.name);
const current = () => loadButtons(db).map((b) => ButtonDef.parse(b));
const button = (over: Partial<ButtonDef> & { label: string; outcome: string }) => ButtonDef.parse({ id: `b-${uuidv7()}`, ...over });
const call = (leadId: string, outcome: string, button_id?: string, fields?: Record<string, string | null>) =>
  logManualCall(db, { lead_id: leadId, idempotency_key: `k-${uuidv7()}`, outcome_code: outcome, button_id, fields }).call_id;

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('Calling screen buttons', () => {
  it('start as one button per active outcome, as before: same names, keys, order and hidden Callback', () => {
    const bs = loadButtons(db);
    const active = Object.entries(OUTCOMES).filter(([, o]) => o.active).sort((a, b) => a[1].sortOrder - b[1].sortOrder);
    expect(bs.map((b) => b.id)).toEqual(active.map(([c]) => c));
    for (const b of bs) {
      const o = OUTCOMES[b.id as keyof typeof OUTCOMES];
      expect(b).toMatchObject({ outcome: b.id, own: true, label: o.label, hidden: !o.offered, default_key: o.hotkey, side: o.kind, show_when: starterShowWhen(b.id), add_tags: [] });
    }
  });

  it('an outcome’s own button keeps its name and "shown" in the outcome (Reports follow a rename)', () => {
    const list = current().map((b) => (b.id === 'bad_number' ? { ...b, label: 'Dial: Wrong #', color: 'red' as const } : b.id === 'callback' ? { ...b, hidden: false } : b));
    saveButtons(db, list);
    expect(loadOutcomeOverrides(db)).toMatchObject({ bad_number: { label: 'Dial: Wrong #' }, callback: { offered: true } });
    expect((db.prepare("SELECT label FROM outcome_code WHERE code = 'bad_number'").get() as { label: string }).label).toBe('Dial: Wrong #');
    const bad = loadButtons(db).find((b) => b.id === 'bad_number')!;
    expect(bad).toMatchObject({ label: 'Dial: Wrong #', color: 'red' });
    // Stored without the name, so the outcome's name is the one truth.
    expect(JSON.stringify((db.prepare("SELECT value_json FROM app_setting WHERE key = 'buttons'").get() as { value_json: string }).value_json)).not.toContain('Wrong #');
  });

  it('your own button counts as its outcome, adds and takes off tags with the call, and keeps its name on the call', () => {
    const jane = lead('Jane');
    const hot = ensureTag(db, 'Hot');
    const vm = ensureTag(db, 'Voicemail');
    tagLead(db, jane, 'Hot');
    const left = button({ label: 'Left voicemail', outcome: 'no_answer', add_tags: [vm.id], remove_tags: [hot.id] });
    saveButtons(db, [...current(), left]);
    const id = call(jane, 'no_answer', left.id);
    // Its own name as a tag, then what it adds and takes off.
    expect(tags(jane)).toEqual(['Left voicemail', 'Voicemail']);
    const line = leadEvents(db, jane)[0]!;
    expect(line).toMatchObject({ kind: 'tag_added', tag_name: 'Voicemail', source: 'button', source_name: 'Left voicemail' });
    expect(db.prepare('SELECT outcome_code, button_id, button_label FROM call_outcome WHERE call_id = ?').get(id)).toEqual({ outcome_code: 'no_answer', button_id: left.id, button_label: 'Left voicemail' });
    // It counts as a no answer, like the outcome's own button.
    const r = buildReport(db, { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString(), tz: 'UTC' });
    expect(r.activity).toMatchObject({ attempts: 1, contacts: 0 });
    // Renamed and then deleted: the call keeps the name it was saved with.
    saveButtons(db, current().map((b) => (b.id === left.id ? { ...b, label: 'VM' } : b)));
    saveButtons(db, current().filter((b) => b.id !== left.id));
    expect(db.prepare('SELECT button_label FROM call_outcome WHERE call_id = ?').get(id)).toEqual({ button_label: 'Left voicemail' });
  });

  it('undoing the call undoes what its button did to tags, and gives the button back', () => {
    const jane = lead('Jane');
    const hot = ensureTag(db, 'Hot');
    const vm = ensureTag(db, 'Voicemail');
    tagLead(db, jane, 'Hot');
    tagLead(db, jane, 'Voicemail');
    const b = button({ label: 'Cold now', outcome: 'no_appt', add_tags: [vm.id], remove_tags: [hot.id] });
    saveButtons(db, [...current(), b]);
    const id = call(jane, 'no_appt', b.id);
    expect(tags(jane)).toEqual(['Cold now', 'Voicemail']);
    const undone = voidCall(db, id);
    expect(undone).toMatchObject({ outcome_code: 'no_appt', button_id: b.id });
    // Hot comes back; Voicemail was on before, so the button didn't add it and the undo leaves it.
    expect(tags(jane)).toEqual(['Hot', 'Voicemail']);
    expect(leadEvents(db, jane).slice(0, 2)).toMatchObject([
      { kind: 'tag_removed', tag_name: 'Cold now', source: 'button', source_name: 'Cold now, undone' },
      { kind: 'tag_added', tag_name: 'Hot', source: 'button', source_name: 'Cold now, undone' },
    ]);
  });

  it('each button tags the lead with its name, replacing the last button\'s tag; history counts them all, and undo and a change of outcome follow', () => {
    const jane = lead('Jane');
    const left = button({ label: 'Left voicemail', outcome: 'no_answer' });
    const quiet = button({ label: 'Quiet one', outcome: 'no_answer', tag_self: false });
    saveButtons(db, [...current(), left, quiet]);
    call(jane, 'no_answer');
    expect(tags(jane)).toEqual(['Dial: No answer']);
    call(jane, 'no_answer', left.id);
    expect(tags(jane)).toEqual(['Left voicemail']);
    const n = (cond: string) => {
      const c = checkCondition(db, cond);
      expect(c.error).toBeNull();
      return c.matched;
    };
    expect(n('times("Dial: No answer") = 1 and has("Left voicemail")')).toBe(1);
    // A button that doesn't tag leaves the last tag on.
    call(jane, 'no_answer', quiet.id);
    expect(tags(jane)).toEqual(['Left voicemail']);
    const picked = call(jane, 'no_appt');
    expect(tags(jane)).toEqual(['Dial: Picked up']);
    // Changing the latest call's outcome changes the tag; undoing it puts the last one back.
    const cur = db.prepare('SELECT id FROM call_outcome WHERE call_id = ?').get(picked) as { id: string };
    changeOutcome(db, picked, { outcome_code: 'appointment', expected_current_id: cur.id });
    expect(tags(jane)).toEqual(['Dial: Appt set']);
    voidCall(db, picked);
    expect(tags(jane)).toEqual(['Left voicemail']);
  });

  it('once, older leads get the tag of their last call\'s button', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    db.prepare("DELETE FROM app_setting WHERE key = 'outcome_tags_done'").run();
    call(jane, 'no_answer');
    call(robert, 'no_appt');
    db.prepare('DELETE FROM lead_tag').run();
    expect(tagLeadsWithLastButton(db, new Date().toISOString())).toBe(2);
    expect(tags(jane)).toEqual(['Dial: No answer']);
    expect(tags(robert)).toEqual(['Dial: Picked up']);
    expect(leadEvents(db, jane)[0]).toMatchObject({ source: 'button', source_name: 'Dial: No answer, from past calls' });
    db.prepare('DELETE FROM lead_tag').run();
    expect(tagLeadsWithLastButton(db, new Date().toISOString())).toBe(0);
  });

  it('once, the First call and Appointment sides become conditions on a smart list, the same rule the sides used', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    saveButtons(db, [...current(), button({ label: 'Hot pickup', outcome: 'no_appt', show_when: 'has("Hot")' })]);
    // A new database has had it done when it opened; an older one gets it on its first open after the update.
    expect(sidesToConditions(db)).toBe(false);
    setSetting(db, 'sides_to_conditions_done', false);
    expect(sidesToConditions(db)).toBe(true);
    expect(sidesToConditions(db)).toBe(false);
    expect(loadStatusDefs(db).filter((s) => s.name === 'Has an appointment')).toHaveLength(1);
    const bs = loadButtons(db);
    expect(bs.find((b) => b.id === 'appt_no_show')!.show_when).toBe('in_list("Has an appointment")');
    expect(bs.find((b) => b.id === 'no_answer')!.show_when).toBe('not in_list("Has an appointment")');
    expect(bs.find((b) => b.label === 'Hot pickup')!.show_when).toBe('not in_list("Has an appointment") and (has("Hot"))');
    const side = (id: string) => {
      const hidden = buttonsHiddenFor(db, id);
      return hidden.includes('no_answer') && !hidden.includes('appt_no_show') ? 'appointment' : !hidden.includes('no_answer') && hidden.includes('appt_no_show') ? 'first_call' : 'both or neither';
    };
    expect(side(jane)).toBe('first_call');
    call(jane, 'appointment');
    expect(side(jane)).toBe('appointment');
    call(jane, 'appt_sale');
    expect(side(jane)).toBe('first_call');
    expect(side(robert)).toBe('first_call');
  });

  it('a button shows only for leads its condition is true for', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    tagLead(db, jane, 'Hot');
    const b = button({ label: 'Hot pickup', outcome: 'no_appt', show_when: 'has("Hot")' });
    saveButtons(db, [...current(), b]);
    // The appointment buttons are hidden too: neither has an appointment.
    const appt = current().filter((x) => x.show_when === 'in_list("Has an appointment")').map((x) => x.id);
    expect(appt.length).toBeGreaterThan(0);
    expect(buttonsHiddenFor(db, jane)).toEqual(appt);
    expect(buttonsHiddenFor(db, robert)).toEqual([...appt, b.id]);
  });

  it('pressed() counts a button by its name, and the outcome counts its buttons too', () => {
    const jane = lead('Jane');
    const b = button({ label: 'Left voicemail', outcome: 'no_answer' });
    saveButtons(db, [...current(), b]);
    call(jane, 'no_answer', b.id);
    call(jane, 'no_answer');
    const n = (cond: string) => {
      const c = checkCondition(db, cond);
      expect(c.error).toBeNull();
      return c.matched;
    };
    expect(n('pressed("Left voicemail") = 1')).toBe(1);
    expect(n('pressed("Dial: No answer") = 2')).toBe(1);
  });

  it('a button tag sets off rules on that tag', () => {
    const jane = lead('Jane');
    runEventRules(db);
    const vm = ensureTag(db, 'Voicemail');
    saveRules(db, [{ id: uuidv7(), name: 'VM is cold', enabled: true, trigger: { kind: 'tag_added', tag: 'Voicemail' }, filter: {}, actions: [{ kind: 'add_tag', tag: 'Cold' }] }]);
    const b = button({ label: 'Left voicemail', outcome: 'no_answer', add_tags: [vm.id] });
    saveButtons(db, [...current(), b]);
    call(jane, 'no_answer', b.id);
    runEventRules(db);
    expect(tags(jane)).toEqual(['Cold', 'Left voicemail', 'Voicemail']);
  });

  it('refuses a broken setup, saying what is wrong', () => {
    const vm = ensureTag(db, 'Voicemail');
    const err = (list: unknown) => {
      try {
        saveButtons(db, list);
      } catch (e) {
        return (e as Error).message;
      }
      return null;
    };
    expect(err([...current(), button({ label: 'Dial: No answer', outcome: 'no_answer' })])).toBe('two buttons are called "Dial: No answer"');
    expect(err([...current(), button({ label: 'X', outcome: 'busy' })])).toBe('X: pick what it counts as');
    expect(err([...current(), button({ label: 'X', outcome: 'no_answer', show_when: 'has(' })])).toMatch(/^X, show when: /);
    expect(err([...current(), button({ label: 'X', outcome: 'no_answer', add_tags: ['nope'] })])).toBe('X: one of its tags is gone');
    expect(err([...current(), button({ label: 'X', outcome: 'no_answer', add_tags: [vm.id], remove_tags: [vm.id] })])).toBe("X: it can't add and take off the same tag");
    expect(err([...current(), { ...button({ label: 'X', outcome: 'no_appt' }), id: 'no_answer' }])).toBe('two buttons have the same id');
    // There are no sides to keep a button on: any button can be hidden.
    expect(err(current().map((b) => (b.side === 'appointment' ? b : { ...b, hidden: true })))).toBeNull();
  });

  it('a call with a button that saves another outcome is refused', () => {
    const b = button({ label: 'Left voicemail', outcome: 'no_answer' });
    saveButtons(db, [...current(), b]);
    expect(() => call(lead('Jane'), 'no_appt', b.id)).toThrow('Left voicemail saves a different outcome');
    expect(() => call(lead('Jane'), 'no_answer', 'b-gone')).toThrow(/that button is gone/);
  });

  it('over HTTP: GET and PUT /api/buttons, meta has them, and the lead says which are hidden for it', async () => {
    const b = button({ label: 'Hot pickup', outcome: 'no_appt', show_when: 'has("Hot")' });
    const put = await app.inject({ method: 'PUT', url: '/api/buttons', headers: write, payload: { buttons: [...current(), b] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().buttons.at(-1)).toMatchObject({ id: b.id, own: false, side: 'first_call', default_key: null });
    const meta = await app.inject({ method: 'GET', url: '/api/meta', headers: write });
    expect(meta.json().buttons.map((x: { id: string }) => x.id)).toContain(b.id);
    const detail = await app.inject({ method: 'GET', url: `/api/leads/${lead('Jane')}`, headers: write });
    expect(detail.json().hidden_buttons).toEqual([...current().filter((x) => x.show_when === 'in_list("Has an appointment")').map((x) => x.id), b.id]);
    const bad = await app.inject({ method: 'PUT', url: '/api/buttons', headers: write, payload: { buttons: [...current(), { ...b, id: 'b-2' }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('two buttons are called "Hot pickup"');
  });
});

describe('fields that show by condition, and buttons that ask for them', () => {
  it('a field shows, and is needed, only while its conditions are true for the lead', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    tagLead(db, jane, 'Appt set');
    const f = createCustomField(db, { label: 'Appt time', type: 'text', show_when: 'has("Appt set")', required_when: 'has("Appt set")' });
    expect(f).toMatchObject({ show_when: 'has("Appt set")', required_when: 'has("Appt set")' });
    const of = (id: string) => leadCustomValues(db, id).find((v) => v.field_id === f.id)!;
    expect(of(jane)).toMatchObject({ shown: true, required: true });
    expect(of(robert)).toMatchObject({ shown: false, required: false });
    // Always shown, never needed, once the conditions are cleared.
    updateCustomField(db, f.id, { label: 'Appt time', type: 'text', show_when: '', required_when: '' });
    expect(of(robert)).toMatchObject({ shown: true, required: false });
    expect(() => updateCustomField(db, f.id, { label: 'Appt time', type: 'text', show_when: 'has(' })).toThrow(/^Appt time, shows when: /);
  });

  it('a button asks for your fields: their values are saved with the call, and a needed one can\'t be blank', () => {
    const jane = lead('Jane');
    const best = createCustomField(db, { label: 'Best time', type: 'text', required_when: 'attempts >= 0' });
    const spouse = createCustomField(db, { label: 'Spouse', type: 'text' });
    const b = button({ label: 'Call back later', outcome: 'no_appt', asks: [best.id, spouse.id] });
    saveButtons(db, [...current(), b]);
    expect(() => call(jane, 'no_appt', b.id, { [spouse.id]: 'Ann' })).toThrow('Best time is needed for this lead');
    call(jane, 'no_appt', b.id, { [best.id]: 'evenings', [spouse.id]: null });
    expect(leadCustomValues(db, jane).filter((v) => v.value).map((v) => [v.label, v.value])).toEqual([['Best time', 'evenings']]);
    // Only the fields the button asks for.
    const other = createCustomField(db, { label: 'Other', type: 'text' });
    expect(() => call(jane, 'no_appt', b.id, { [other.id]: 'x' })).toThrow("Call back later doesn't ask for that field");
    expect(() => call(jane, 'no_appt', undefined, { [other.id]: 'x' })).toThrow('only a button that asks for a field saves one with the call');
  });

  it('a button can\'t ask for a counter or a formula, and a deleted field or tag drops out of its button', () => {
    const c = createCustomField(db, { label: 'Streak', type: 'counter' });
    expect(() => saveButtons(db, [...current(), button({ label: 'X', outcome: 'no_appt', asks: [c.id] })])).toThrow("X: Streak is a counter, so a button can't ask for it");
    const t = ensureTag(db, 'Gone soon');
    const f = createCustomField(db, { label: 'Temp', type: 'text' });
    const b = button({ label: 'Y', outcome: 'no_appt', asks: [f.id], add_tags: [t.id] });
    saveButtons(db, [...current(), b]);
    db.prepare('DELETE FROM lead_tag WHERE tag_id = ?').run(t.id);
    db.prepare('DELETE FROM tag WHERE id = ?').run(t.id);
    db.prepare('DELETE FROM custom_field WHERE id = ?').run(f.id);
    expect(loadButtons(db).find((x) => x.id === b.id)).toMatchObject({ asks: [], add_tags: [] });
    expect(() => saveButtons(db, current())).not.toThrow();
  });
});
