import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { ensureTag, leadEvents, setNeverDial, tagLead } from '../../src/server/domain/tags.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { loadCallingSettings, saveCallingSettings } from '../../src/server/domain/callingSettings.js';
import { createCustomField, setCustomValues } from '../../src/server/domain/customFields.js';
import { logTexted, textSection, textsForLead } from '../../src/server/domain/texts.js';
import { buildReport } from '../../src/server/domain/reports.js';
import { buildApp } from '../../src/server/http/app.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const write = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const day = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  const s = loadCallingSettings(db);
  saveCallingSettings(db, {
    ...s,
    scripts: { ...s.scripts, agent_name: 'Alistair' },
    texts: [
      { id: 't1', name: 'First touch', body: 'Hi [[first_name]], it\'s [[my_name]] about your [[loan_amount]] loan with [[lender]] in [[city]]. [[Spouse]] [[Lead Notes]]' },
      { id: 't2', name: 'Appt', body: 'See you [[appointment]], [[first_name]]!' },
    ],
  });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('texts', () => {
  it('fills in the lead, your name, your fields and the sheet\'s other columns', () => {
    const jane = lead('Jane');
    const f = createCustomField(db, { label: 'Spouse', type: 'text' } as any);
    setCustomValues(db, jane, { [f.id]: 'Bob' });
    const r = textsForLead(db, jane);
    expect(r.blocked).toBeNull();
    expect(r.texts[0]).toMatchObject({ id: 't1', name: 'First touch', missing: [] });
    expect(r.texts[0]!.text).toBe('Hi Jane, it\'s Alistair about your $286,000 loan with Rocket Mortgage in Columbus. Bob prefers evenings');
    expect(r.texts[1]).toMatchObject({ text: 'See you, Jane!', missing: ['appointment'] });
  });

  it('keeps a long text with its line breaks (over 1,000 characters), and fills in today', () => {
    const long = `**TIME-SENSITIVE**\nToday [[today]]\n\n${'12:00-12:45 PM\n'.repeat(80)}Thank you,\n[[my_name]]`;
    expect(long.length).toBeGreaterThan(1000);
    const s = loadCallingSettings(db);
    saveCallingSettings(db, { ...s, texts: [{ id: 't3', name: 'Confirm', body: long }] });
    expect(loadCallingSettings(db).texts[0]!.body).toBe(long);
    const text = textsForLead(db, lead('Jane')).texts[0]!.text;
    expect(text).toMatch(/^\*\*TIME-SENSITIVE\*\*\nToday \w+day, \w{3} \d{1,2}\n\n12:00-12:45 PM\n/);
    expect(text.endsWith('Thank you,\nAlistair')).toBe(true);
    expect(() => saveCallingSettings(db, { ...s, texts: [{ id: 't4', name: 'Too long', body: 'x'.repeat(2001) }] })).toThrow();
  });

  it('logs a text sent on the lead, refuses a never-dial or do-not-call lead, and Reports counts texts that led to a booking', () => {
    const jane = lead('Jane');
    const robert = lead('Robert');
    const ann = lead('Ann');
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(logTexted(db, jane, 't1', hourAgo)).toEqual({ logged: true });
    expect(leadEvents(db, jane)[0]).toMatchObject({ kind: 'texted', source: 'you', source_name: 'First touch' });
    logTexted(db, robert, 't1', hourAgo);
    logTexted(db, robert, 't2', hourAgo);
    expect(() => logTexted(db, jane, 'gone')).toThrow(/gone/);

    // Jane books after her text; Robert doesn't.
    logManualCall(db, { lead_id: jane, idempotency_key: uuidv7(), outcome_code: 'appointment' });
    const s = textSection(db, day().from, day().to)!;
    expect(s).toMatchObject({ texts: 3, leads: 2, booked: 1 });
    expect(s.rows).toEqual([
      { name: 'First touch', texts: 2, leads: 2, booked: 1 },
      { name: 'Appt', texts: 1, leads: 1, booked: 0 },
    ]);
    expect(buildReport(db, { ...day(), tz: 'America/New_York' }).texts).toMatchObject({ texts: 3 });

    setNeverDial(db, ensureTag(db, 'DNC').id, true);
    tagLead(db, ann, 'DNC');
    expect(textsForLead(db, ann).blocked).toMatch(/DNC/);
    expect(() => logTexted(db, ann, 't1')).toThrow(/Not texted/);
    logManualCall(db, { lead_id: robert, idempotency_key: uuidv7(), outcome_code: 'no_answer', do_not_call: true });
    expect(textsForLead(db, robert).blocked).toMatch(/asked not to be contacted/);
  });

  it('over HTTP', async () => {
    const jane = lead('Jane');
    const r = await app.inject({ url: `/api/leads/${jane}/texts`, headers: write });
    expect(r.json().texts[0].text).toContain('Hi Jane');
    const sent = await app.inject({ method: 'POST', url: `/api/leads/${jane}/texted`, headers: write, payload: { text_id: 't2' } });
    expect(sent.json()).toEqual({ logged: true });
    expect(leadEvents(db, jane)[0]).toMatchObject({ kind: 'texted', source_name: 'Appt' });
    const none = await app.inject({ method: 'POST', url: '/api/texts/to-phone', headers: write, payload: { text: 'hi' } });
    expect(none.statusCode).toBe(400);
  });
});
