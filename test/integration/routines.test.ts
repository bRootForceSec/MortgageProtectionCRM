import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { addToCallList, getCallList, saveCallListAs, callListMeta } from '../../src/server/domain/callList.js';
import { chooseRoutine, loadRoutines, routineToday, saveRoutines, startStep } from '../../src/server/domain/routines.js';
import type { Routine } from '../../src/shared/routines.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';
import type { Config } from '../../src/server/config.js';
import { uuidv7 } from '../../src/server/ids.js';

let db: DB;
let config: Config;
const id = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const key = () => `k-${uuidv7()}`;
const allNew = () => (db.prepare("SELECT COUNT(*) n FROM lead_state WHERE status = 'new'").get() as { n: number }).n;

beforeEach(async () => {
  ({ db, c: config } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
});

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  name: 'Weekdays',
  days: [0, 1, 2, 3, 4, 5, 6],
  steps: [
    { id: 's-imports', name: "Today's imports", order: 'set', source: { kind: 'filter', filter: { status: 'new', imported: 'today' } } },
    { id: 's-na', name: "Today's no-answers", order: 'best_time', source: { kind: 'filter', filter: { status: 'no_answer', last_call: 'today', not_within_min: 0 } } },
  ],
  ...over,
});

describe('daily routines', () => {
  it('starts with the routine you described, every day', () => {
    const r = loadRoutines(db);
    expect(r).toHaveLength(1);
    expect(r[0]!.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r[0]!.steps.map((s) => s.name)).toEqual(['No-shows', "Today's imports", "Today's no-answers"]);
    // Saved, so the ids stay the same.
    expect(loadRoutines(db)[0]!.id).toBe(r[0]!.id);
  });

  it('picks the routine for the weekday, and you can switch for today', () => {
    const now = new Date();
    saveRoutines(db, [routine({ id: 'a', name: 'Not today', days: [(now.getDay() + 1) % 7] }), routine({ id: 'b', name: 'Today', steps: [] })]);
    expect(routineToday(db, now).routine).toEqual({ id: 'b', name: 'Today' });
    expect(routineToday(db, now).choices).toEqual([{ id: 'a', name: 'Not today', today: false }, { id: 'b', name: 'Today', today: true }]);
    expect(chooseRoutine(db, 'a', now).routine?.id).toBe('a');
    // Tomorrow starts fresh.
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
    saveRoutines(db, [routine({ id: 'a', days: [] }), routine({ id: 'b', days: [], steps: [] })]);
    expect(routineToday(db, tomorrow).routine).toBeNull();
  });

  it('a step adds its leads under the list, counts down as you call, and the next step picks up the no-answers', () => {
    saveRoutines(db, [routine()]);
    const steps = () => Object.fromEntries(routineToday(db).steps.map((s) => [s.id, s]));
    expect(steps()['s-imports']).toMatchObject({ count: allNew(), started_at: null, total: 0, called: 0 });

    const r = startStep(db, 's-imports', 'add', null);
    expect(r).toMatchObject({ added: allNew(), order: 'set' });
    expect(steps()['s-imports']).toMatchObject({ count: 0, total: r.added, called: 0 });
    expect(steps()['s-imports']!.started_at).not.toBeNull();

    const jane = id('Jane');
    logManualCall(db, { lead_id: jane, idempotency_key: key(), outcome_code: 'no_answer' });
    expect(steps()['s-imports']!.called).toBe(1);
    expect(steps()['s-na']!.count).toBe(1);

    const n = getCallList(db).length;
    expect(startStep(db, 's-na', 'add', null)).toMatchObject({ added: 1, order: 'best_time' });
    expect(getCallList(db)).toHaveLength(n);
    expect(getCallList(db).at(-1)).toMatchObject({ lead_id: jane, done: null });
  });

  it('replace saves the current list first, and a saved-list step loads that list', () => {
    const jane = id('Jane');
    addToCallList(db, [jane]);
    const saved = saveCallListAs(db, 'leftovers')!;
    saveRoutines(db, [routine({ steps: [
      { id: 's-imports', name: 'Imports', order: 'set', source: { kind: 'filter', filter: { status: 'new', imported: 'today' } } },
      { id: 's-left', name: 'Leftovers', order: 'set', source: { kind: 'saved_list', list_id: saved.id } },
    ] })]);

    startStep(db, 's-imports', 'replace', 'before routine');
    expect(getCallList(db)).toHaveLength(allNew());
    startStep(db, 's-left', 'replace', null);
    expect(getCallList(db).map((i) => i.lead_id)).toEqual([jane]);
    expect(callListMeta(db)).toMatchObject({ name: 'leftovers', saved_list_id: saved.id });
  });

  it('refuses steps that are not today, bad routines, and gone saved lists', () => {
    saveRoutines(db, [routine({ steps: [{ id: 's-gone', name: 'Gone', order: 'set', source: { kind: 'saved_list', list_id: 'nope' } }] })]);
    expect(routineToday(db).steps[0]!.count).toBeNull();
    expect(() => startStep(db, 's-gone', 'add', null)).toThrow(/gone/);
    expect(() => startStep(db, 'nope', 'add', null)).toThrow(/today's routine/);
    // A step with nothing to call isn't counted as started.
    saveRoutines(db, [routine()]);
    expect(startStep(db, 's-na', 'add', null).added).toBe(0);
    expect(routineToday(db).steps.find((s) => s.id === 's-na')!.started_at).toBeNull();
    expect(() => saveRoutines(db, [routine(), routine()])).toThrow(/same id/);
    expect(() => saveRoutines(db, [routine({ name: ' ' })])).toThrow();
    expect(() => saveRoutines(db, [routine({ steps: [{ id: 'x', name: 'x', order: 'set', source: { kind: 'filter', filter: { appt_days: 'last_month' } } }] })])).toThrow();
  });

  it('over HTTP', async () => {
    const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
    const headers = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}`, origin: 'http://127.0.0.1:5170' };
    const app = await buildApp({ db, config, token: TOKEN });
    const put = await app.inject({ method: 'PUT', url: '/api/routines', headers, payload: { routines: [routine()] } });
    expect(put.statusCode).toBe(200);
    const bad = await app.inject({ method: 'PUT', url: '/api/routines', headers, payload: { routines: [{ ...routine(), days: [9] }] } });
    expect(bad.statusCode).toBe(400);
    const today = await app.inject({ url: '/api/routine/today', headers });
    expect(today.json().steps.map((s: { id: string }) => s.id)).toEqual(['s-imports', 's-na']);
    const start = await app.inject({ method: 'POST', url: '/api/routine/steps/s-imports/start', headers, payload: { mode: 'add' } });
    expect(start.json()).toMatchObject({ added: allNew(), order: 'set' });
    await app.close();
  });
});
