import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { ensureTag, leadEvents, listTags, setNeverDial, tagLead } from '../../src/server/domain/tags.js';
import { addToCallList, getCallList } from '../../src/server/domain/callList.js';
import { runRuleById, saveRules } from '../../src/server/domain/rules.js';
import { buildApp } from '../../src/server/http/app.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const write = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const onList = () => getCallList(db).map((i) => i.lead_id);

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('never dial', () => {
  it('a lead with a never-dial tag is skipped, with why, and goes on anyway when you say so (noted on the lead)', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    const dnc = ensureTag(db, 'DNC');
    tagLead(db, jane, 'DNC');
    // Not marked yet: nothing changes.
    expect(addToCallList(db, [jane]).added).toBe(1);
    db.prepare('DELETE FROM call_list_item').run();
    expect(setNeverDial(db, dnc.id, true)).toMatchObject({ name: 'DNC', never_dial: true });
    expect(listTags(db).find((t) => t.id === dnc.id)?.never_dial).toBe(true);
    const r = addToCallList(db, [jane, robert]);
    expect(r).toMatchObject({ added: 1, skipped: [{ lead_id: jane, name: 'Jane Doe', why: 'tagged DNC' }] });
    expect(onList()).toEqual([robert]);
    const again = addToCallList(db, [jane], undefined, { override: true });
    expect(again).toMatchObject({ added: 1, skipped: [] });
    expect(onList()).toEqual([robert, jane]);
    expect(leadEvents(db, jane)[0]).toMatchObject({ kind: 'never_dial_override', tag_name: 'DNC', source: 'you', source_name: 'added anyway' });
  });

  it('a rule can\'t put a never-dial lead on the list', () => {
    const jane = lead('Jane');
    setNeverDial(db, ensureTag(db, 'DNC').id, true);
    tagLead(db, jane, 'DNC');
    saveRules(db, [{ id: 'r1', name: 'All on', enabled: true, trigger: { kind: 'manual' }, filter: {}, actions: [{ kind: 'add_to_list' }] }]);
    runRuleById(db, 'r1', false);
    expect(onList()).not.toContain(jane);
    expect(onList().length).toBeGreaterThan(0);
  });

  it('over HTTP: mark a tag, the lead says why, Add anyway, and a dial past it is noted', async () => {
    const jane = lead('Jane');
    const dnc = ensureTag(db, 'DNC');
    tagLead(db, jane, 'DNC');
    const mark = await app.inject({ method: 'PUT', url: `/api/tags/${dnc.id}/never-dial`, headers: write, payload: { on: true } });
    expect(mark.json()).toMatchObject({ never_dial: true });
    const detail = (await app.inject({ url: `/api/leads/${jane}`, headers: write })).json();
    expect(detail.never_dial).toMatchObject({ tag: 'DNC', source: 'you' });
    const add = await app.inject({ method: 'POST', url: '/api/call-list', headers: write, payload: { lead_ids: [jane] } });
    expect(add.json()).toMatchObject({ added: 0, skipped: [{ lead_id: jane }] });
    const anyway = await app.inject({ method: 'POST', url: '/api/call-list', headers: write, payload: { lead_ids: [jane], override: true } });
    expect(anyway.json()).toMatchObject({ added: 1 });
    const dialed = await app.inject({ method: 'POST', url: `/api/leads/${jane}/dialed-anyway`, headers: write, payload: {} });
    expect(dialed.json()).toEqual({ logged: true });
    expect(leadEvents(db, jane)[0]).toMatchObject({ kind: 'never_dial_override', source_name: 'dialed anyway' });
    // A lead with no never-dial tag has nothing to note.
    expect((await app.inject({ method: 'POST', url: `/api/leads/${lead('Robert')}/dialed-anyway`, headers: write, payload: {} })).json()).toEqual({ logged: false });
  });
});
