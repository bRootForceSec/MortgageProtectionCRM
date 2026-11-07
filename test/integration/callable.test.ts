import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { addLeadAction, logManualCall } from '../../src/server/domain/calls.js';
import { addToCallList, getCallList } from '../../src/server/domain/callList.js';
import { loadCallingSettings, saveCallingSettings } from '../../src/server/domain/callingSettings.js';
import { callableIds } from '../../src/server/domain/callable.js';
import { listLeads, getLeadDetail } from '../../src/server/domain/leads.js';
import { tagLead } from '../../src/server/domain/tags.js';
import { STARTER_CALLABLE } from '../../src/shared/callingSettings.js';
import { buildApp } from '../../src/server/http/app.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const write = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const setCallable = (c: string) => saveCallingSettings(db, { ...loadCallingSettings(db), callable_when: c });
const all = () => (db.prepare('SELECT id FROM lead').all() as { id: string }[]).map((r) => r.id);

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  db.prepare('DELETE FROM call_list_item').run();
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('who can be called', () => {
  it('starts as every lead but booked ones, as before', () => {
    expect(loadCallingSettings(db).callable_when).toBe(STARTER_CALLABLE);
    const jane = lead('Jane');
    logManualCall(db, { lead_id: jane, idempotency_key: uuidv7(), outcome_code: 'appointment' });
    expect(callableIds(db, all()).has(jane)).toBe(false);
    expect(addToCallList(db, [jane])).toMatchObject({ added: 0, not_callable: 1 });
    expect(getLeadDetail(db, '', jane).callable).toBe(false);
    expect(listLeads(db, {}).rows.find((r) => r.id === jane)?.callable).toBe(false);
    expect(listLeads(db, {}).rows.filter((r) => r.callable).length).toBe(all().length - 1);
  });

  it('your own condition decides, everywhere: here only leads tagged Hot, and booked ones too once you allow them', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    tagLead(db, jane, 'Hot');
    setCallable('has("Hot")');
    expect([...callableIds(db, all())]).toEqual([jane]);
    expect(addToCallList(db, [jane, robert])).toMatchObject({ added: 1, not_callable: 1 });
    expect(getCallList(db).map((i) => i.lead_id)).toEqual([jane]);
    expect(getLeadDetail(db, '', robert).callable).toBe(false);

    // Blank: every lead, booked or not.
    logManualCall(db, { lead_id: robert, idempotency_key: uuidv7(), outcome_code: 'appointment' });
    setCallable('');
    expect(callableIds(db, [robert]).has(robert)).toBe(true);
  });

  it('never a lead in the dead pile, whatever the condition says', () => {
    const jane = lead('Jane');
    addLeadAction(db, jane, 'mark_dead', 'test');
    setCallable('');
    expect(callableIds(db, [jane]).size).toBe(0);
    setCallable('True');
    expect(addToCallList(db, [jane]).not_callable).toBe(1);
  });

  it('a mistake is refused when saving, saying where', async () => {
    expect(() => setCallable('attempts >')).toThrow(/Can be called when/);
    const r = await app.inject({ method: 'PUT', url: '/api/settings/calling', headers: write, payload: { ...loadCallingSettings(db), callable_when: 'nope(' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/^"Can be called when": /);
    expect(loadCallingSettings(db).callable_when).toBe(STARTER_CALLABLE);
  });
});

describe('the lead sheet layout', () => {
  it('is saved with the calling settings', async () => {
    const sheet = { blocks: [{ id: 'outcome', shown: true }, { id: 'lead', shown: true }, { id: 'notes', shown: false }], dial_counter: false, caller_id: true };
    const r = await app.inject({ method: 'PUT', url: '/api/settings/calling', headers: write, payload: { ...loadCallingSettings(db), sheet } });
    expect(r.statusCode).toBe(200);
    expect(loadCallingSettings(db).sheet).toEqual(sheet);
  });
});
