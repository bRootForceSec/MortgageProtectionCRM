import { describe, it, expect } from 'vitest';
import { tempDb } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { exportSetup, loadSetup } from '../../src/server/domain/setup.js';
import { ensureTag, listTags, setNeverDial } from '../../src/server/domain/tags.js';
import { createCustomField, listCustomFields } from '../../src/server/domain/customFields.js';
import { loadStatusDefs } from '../../src/server/domain/formulas.js';
import { listStatuses, saveStatuses } from '../../src/server/domain/statuses.js';
import { loadButtons, saveButtons } from '../../src/server/domain/buttons.js';
import { loadRules, saveRules } from '../../src/server/domain/rules.js';
import { loadCallingSettings, saveCallingSettings } from '../../src/server/domain/callingSettings.js';
import { ButtonDef } from '../../src/shared/buttons.js';
import { buildApp } from '../../src/server/http/app.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const write = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };

/** A setup with a tag, two fields (one a formula over the other), a smart list, a button, a rule and a calling condition. */
function setUp(db: DB) {
  const hot = ensureTag(db, 'Hot');
  setNeverDial(db, ensureTag(db, 'DNC').id, true);
  const payment = createCustomField(db, { label: 'Payment', type: 'money' });
  createCustomField(db, { label: 'Double', type: 'formula', formula: '[Payment] * 2' });
  saveStatuses(db, [...loadStatusDefs(db), { id: 's1', name: 'Hot ones', condition: 'has("Hot")', color: 'red', tab: true }]);
  saveButtons(db, [...loadButtons(db).map((b) => ButtonDef.parse(b)), ButtonDef.parse({ id: 'b-hot', outcome: 'no_answer', label: 'Hot lead', add_tags: [hot.id], asks: [payment.id] })]);
  saveRules(db, [{ id: 'r1', name: 'Hot gets a field', enabled: true, trigger: { kind: 'tag_added', tag: 'Hot' }, filter: {}, actions: [{ kind: 'set_field', field_id: payment.id, value: '100' }] }]);
  saveCallingSettings(db, { ...loadCallingSettings(db), callable_when: 'in_list("Hot ones")' });
}

describe('your setup as one file', () => {
  it('saved from one database and loaded into another, it works there with that one\'s tags and fields', () => {
    const a = tempDb().db;
    setUp(a);
    const file = JSON.parse(JSON.stringify(exportSetup(a)));
    expect(file).toMatchObject({ kind: 'mpcrm-setup', version: 1 });

    const b = tempDb().db;
    // Here Hot already exists, under another id.
    const hotHere = ensureTag(b, 'hot');
    expect(loadSetup(b, file)).toEqual({ tags_added: 1, fields_added: 2 });
    expect(listTags(b).map((t) => [t.name, t.never_dial])).toEqual([['DNC', true], ['hot', false]]);
    const payment = listCustomFields(b).find((f) => f.label === 'Payment')!;
    expect(listCustomFields(b).find((f) => f.label === 'Double')?.formula).toBe('[Payment] * 2');
    expect(listStatuses(b).map((s) => s.name)).toEqual(listStatuses(a).map((s) => s.name));
    expect(listStatuses(b).map((s) => s.name)).toContain('Hot ones');
    expect(loadButtons(b).find((x) => x.id === 'b-hot')).toMatchObject({ label: 'Hot lead', add_tags: [hotHere.id], asks: [payment.id] });
    expect(loadRules(b).find((r) => r.id === 'r1')?.actions).toEqual([{ kind: 'set_field', field_id: payment.id, value: '100' }]);
    expect(loadCallingSettings(b).callable_when).toBe('in_list("Hot ones")');
    // Loading it again changes nothing.
    expect(loadSetup(b, file)).toEqual({ tags_added: 0, fields_added: 0 });
  });

  it('a file with a mistake changes nothing and says where; another kind of file is refused', () => {
    const a = tempDb().db;
    setUp(a);
    const file = JSON.parse(JSON.stringify(exportSetup(a)));
    file.statuses.at(-1).condition = 'has("Hot") and';
    const b = tempDb().db;
    const before = exportSetup(b, 'now');
    expect(() => loadSetup(b, file)).toThrow(/^Smart lists: /);
    expect(exportSetup(b, 'now')).toEqual(before);
    expect(() => loadSetup(b, { rows: [] })).toThrow("that isn't a setup file saved from this CRM");
  });

  it('Settings → Backups: save it as a file, and load one', async () => {
    const t = tempDb();
    setUp(t.db);
    const app = await buildApp({ db: t.db, config: t.c, token: TOKEN });
    const got = await app.inject({ method: 'GET', url: '/api/setup/file', headers: write });
    expect(got.headers['content-disposition']).toMatch(/attachment; filename="mpcrm-setup-\d{4}-\d{2}-\d{2}\.json"/);
    const b = tempDb();
    const app2 = await buildApp({ db: b.db, config: b.c, token: TOKEN });
    const r = await app2.inject({ method: 'POST', url: '/api/setup', headers: write, payload: got.json() });
    expect(r.json()).toEqual({ tags_added: 2, fields_added: 2 });
    const bad = await app2.inject({ method: 'POST', url: '/api/setup', headers: write, payload: { kind: 'other' } });
    expect(bad.statusCode).toBe(400);
  });
});
