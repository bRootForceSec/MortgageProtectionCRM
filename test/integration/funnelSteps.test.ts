import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import type { DB } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { tagLead } from '../../src/server/domain/tags.js';
import { funnelFormulaCounts, loadFunnelSteps, saveFunnelSteps } from '../../src/server/domain/funnel.js';
import { STARTER_FUNNEL, type FunnelStepDef } from '../../src/shared/funnel.js';
import { buildApp } from '../../src/server/http/app.js';
import { uuidv7 } from '../../src/server/ids.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const write = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const step = (id: string, name: string, formula: string): FunnelStepDef => ({ id, name, count: { by: 'formula', formula } });
const now = Date.now();
const around = { from: new Date(now - 3_600_000).toISOString(), to: new Date(now + 3_600_000).toISOString() };
const longAgo = { from: '2000-01-01T00:00:00.000Z', to: '2000-01-02T00:00:00.000Z' };

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('your funnel steps', () => {
  it('start as the seven the CRM keeps', () => {
    expect(loadFunnelSteps(db)).toEqual(STARTER_FUNNEL);
    expect(STARTER_FUNNEL.map((s) => s.name)).toEqual(['Dials', 'Leads called', 'Pickups', 'Appts set', 'Sat', 'Presentations', 'Sales']);
  });

  it('a formula step counts over your leads, with the log only in the period', () => {
    tagLead(db, lead('Jane'), 'Hot');
    tagLead(db, lead('Ann'), 'Hot');
    logManualCall(db, { lead_id: lead('Robert'), idempotency_key: uuidv7(), outcome_code: 'appointment' });
    const steps = [
      ...STARTER_FUNNEL,
      step('hot', 'Hot', 'times("Hot")'),
      step('hot_leads', 'Hot now', 'has("Hot")'),
      step('booked', 'Booked', 'pressed("Dial: Appt set") > 0'),
    ];
    saveFunnelSteps(db, steps);
    expect(funnelFormulaCounts(db, around.from, around.to)).toEqual({ hot: 2, hot_leads: 2, booked: 1 });
    // Long ago: the log is empty then, but has() is how the lead is now.
    expect(funnelFormulaCounts(db, longAgo.from, longAgo.to)).toEqual({ hot: 0, hot_leads: 2, booked: 0 });
  });

  it('refuses text, two steps with one name, and no steps', () => {
    expect(() => saveFunnelSteps(db, [step('a', 'State', 'state')])).toThrow(/Funnel step "State": a funnel step has to be a number/);
    expect(() => saveFunnelSteps(db, [step('a', 'Hot', 'times("Hot")'), step('b', 'hot', 'has("Hot")')])).toThrow(/two funnel steps are called "hot"/);
    expect(() => saveFunnelSteps(db, [])).toThrow();
    expect(loadFunnelSteps(db)).toEqual(STARTER_FUNNEL);
  });

  it('the top bar gets your steps and what the formula ones counted', async () => {
    tagLead(db, lead('Jane'), 'Hot');
    const put = await app.inject({ method: 'PUT', url: '/api/funnel/steps', headers: write, payload: [STARTER_FUNNEL[0], step('hot', 'Hot', 'times("Hot")')] });
    expect(put.statusCode).toBe(200);
    const r = await app.inject({ method: 'GET', url: `/api/stats/today?from=${around.from}&to=${around.to}`, headers: write });
    expect(r.json().steps.map((s: FunnelStepDef) => s.name)).toEqual(['Dials', 'Hot']);
    expect(r.json().formula_counts).toEqual({ hot: 1 });
    const bad = await app.inject({ method: 'PUT', url: '/api/funnel/steps', headers: write, payload: [step('x', 'X', 'nope(')] });
    expect(bad.statusCode).toBe(400);
  });
});
