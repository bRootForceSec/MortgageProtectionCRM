import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { addToCallList, leadFilterWhere } from '../../src/server/domain/callList.js';
import { buildReport, todayStats } from '../../src/server/domain/reports.js';
import { rebuildLeadState, verifyLeadState } from '../../src/server/domain/leadState.js';
import { addNumber, numberStats } from '../../src/server/domain/numbers.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

// Characterization: what one call with each outcome does to a lead that was never called. It pins the lead's status,
// how its appointment stands, which Leads page tabs it shows under, whether it can go on the call list, and what it
// adds to the top bar, the funnel and Reports. Retired outcomes are included because older calls still carry them.

let db: DB;
let lead: string;
let numberId: string;

/** Every tab on the Leads page, plus the "put back after an appointment" filter. */
const TABS = ['new', 'no_answer', 'talked', 'callback', 'appointment_set', 'appt_missed', 'appt_no_show', 'appt_sat_no_sale', 'appt_prezi', 'appt_sold', 'invalid', 'dead'];
const tabsOf = (leadId: string) =>
  TABS.filter((status) => {
    const w = leadFilterWhere({ status });
    return !!db.prepare(`SELECT 1 FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE l.id = @id AND ${w.sql}`).get({ ...w.params, id: leadId });
  });

beforeEach(async () => {
  ({ db } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  lead = (db.prepare("SELECT id FROM lead WHERE first_name = 'Robert'").get() as { id: string }).id;
  numberId = (addNumber(db, { number: '(614) 555-0199', label: 'Main' }) as { id: string }).id;
});

const at = new Date(Date.now() - 30 * 60_000).toISOString();
const range = { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() };
const today = at.slice(0, 10);

function effects(code: string) {
  const active = (db.prepare('SELECT active FROM outcome_code WHERE code = ?').get(code) as { active: number }).active;
  const needsTime = code === 'callback';
  const { call_id } = logManualCall(db, {
    lead_id: lead, idempotency_key: `k-${uuidv7()}`, occurred_at: at, dial_count: 2, from_number_id: numberId,
    outcome_code: active ? code : 'no_answer',
    callback_due_at: needsTime ? new Date(Date.now() + 86_400_000).toISOString() : null,
  });
  if (!active) {
    // A retired outcome can't be logged any more, but older calls carry it.
    db.prepare('UPDATE call_outcome SET outcome_code = ? WHERE call_id = ?').run(code, call_id);
    rebuildLeadState(db, [lead]);
  }
  const s = db.prepare('SELECT status, appt_result, appt_missed, next_due_at IS NOT NULL due FROM lead_state WHERE lead_id = ?').get(lead) as Record<string, unknown>;
  const t = todayStats(db, range.from, range.to, undefined, { from: today, to: today });
  const r = buildReport(db, { ...range, tz: 'UTC' });
  const n = numberStats(db, range.from);
  expect(verifyLeadState(db)).toEqual([]);
  return {
    status: s.status,
    appt_result: s.appt_result,
    appt_missed: s.appt_missed,
    due: !!s.due,
    tabs: tabsOf(lead),
    callable: addToCallList(db, [lead]).added === 1,
    top_bar: { attempts: t.attempts, dials: t.dials, leads: t.unique_leads, pickups: t.human_contacts, appts: t.appointments, callbacks: t.callbacks },
    funnel: t.funnel,
    report: {
      attempts: r.activity.attempts, contacts: r.activity.contacts, appointments: r.activity.appointments,
      callbacks: r.activity.callbacks, bad_numbers: r.activity.bad_numbers, appts_booked_or_logged: r.appointments?.appointments ?? null,
    },
    numbers: { calls: n[0]!.calls_today, contacts: n[0]!.contacts_7d, appointments: n[0]!.appointments },
  };
}

const none = { attempts: 0, dials: 0, leads: 0, pickups: 0, appts: 0, callbacks: 0 };
const first = (pickups: number, appts = 0, callbacks = 0) => ({ attempts: 1, dials: 2, leads: 1, pickups, appts, callbacks });
const noFunnel = { sat: 0, prezis: 0, sales: 0 };
const report = (contacts: number, appointments = 0, callbacks = 0, bad_numbers = 0, attempts = 1) =>
  ({ attempts, contacts, appointments, callbacks, bad_numbers });

describe('what one call with each outcome does', () => {
  const cases: [string, Record<string, unknown>][] = [
    // First call side (active)
    ['no_answer', { status: 'retry', appt_result: null, appt_missed: 0, due: true, tabs: ['no_answer'], callable: true, top_bar: first(0), funnel: noFunnel, report: report(0) }],
    ['no_appt', { status: 'retry', appt_result: null, appt_missed: 0, due: true, tabs: ['talked'], callable: true, top_bar: first(1), funnel: noFunnel, report: report(1) }],
    ['appointment', { status: 'appointment_set', appt_result: null, appt_missed: 0, due: false, tabs: ['appointment_set'], callable: false, top_bar: first(1, 1), funnel: noFunnel, report: report(1, 1) }],
    ['bad_number', { status: 'invalid', appt_result: null, appt_missed: 0, due: false, tabs: ['invalid'], callable: false, top_bar: first(0), funnel: noFunnel, report: report(0, 0, 0, 1) }],
    ['callback', { status: 'callback', appt_result: null, appt_missed: 0, due: true, tabs: ['callback'], callable: true, top_bar: first(1, 0, 1), funnel: noFunnel, report: report(1, 0, 1) }],
    // Appointment side (active): not first calls, so they add nothing to dials, pickups or appointments set.
    ['appt_no_show', { status: 'retry', appt_result: 'no_show', appt_missed: 1, due: false, tabs: ['appt_missed', 'appt_no_show'], callable: true, top_bar: none, funnel: noFunnel, report: report(0, 0, 0, 0, 0) }],
    ['appt_sat_no_sale', { status: 'retry', appt_result: 'sat_no_sale', appt_missed: 1, due: false, tabs: ['appt_missed', 'appt_sat_no_sale'], callable: true, top_bar: none, funnel: { sat: 1, prezis: 0, sales: 0 }, report: report(0, 0, 0, 0, 0) }],
    ['appt_prezi', { status: 'retry', appt_result: 'prezi', appt_missed: 1, due: false, tabs: ['appt_missed', 'appt_prezi'], callable: true, top_bar: none, funnel: { sat: 1, prezis: 1, sales: 0 }, report: report(0, 0, 0, 0, 0) }],
    ['appt_sale', { status: 'appointment_set', appt_result: 'sold', appt_missed: 0, due: false, tabs: ['appointment_set', 'appt_sold'], callable: false, top_bar: none, funnel: { sat: 1, prezis: 1, sales: 1 }, report: report(0, 0, 0, 0, 0) }],
    ['appt_rescheduled', { status: 'appointment_set', appt_result: 'rescheduled', appt_missed: 0, due: false, tabs: ['appointment_set'], callable: false, top_bar: none, funnel: noFunnel, report: report(0, 0, 0, 0, 0) }],
    // Retired first-call outcomes that older calls still carry.
    ['vm_left', { status: 'retry', tabs: ['no_answer'], callable: true, top_bar: first(0), report: report(0) }],
    ['vm_no_msg', { status: 'retry', tabs: ['no_answer'], callable: true, top_bar: first(0), report: report(0) }],
    ['busy', { status: 'retry', tabs: ['no_answer'], callable: true, top_bar: first(0), report: report(0) }],
    ['not_interested', { status: 'retry', tabs: ['talked'], callable: true, top_bar: first(1), report: report(1) }],
    ['hung_up', { status: 'retry', tabs: ['talked'], callable: true, top_bar: first(1), report: report(1) }],
    ['picked_up', { status: 'retry', tabs: ['talked'], callable: true, top_bar: first(1), report: report(1) }],
    ['other', { status: 'retry', tabs: ['talked'], callable: true, top_bar: first(1), report: report(1) }],
    ['wrong_person', { status: 'invalid', tabs: ['invalid'], callable: false, top_bar: first(0), report: report(0, 0, 0, 1) }],
    ['dnc_request', { status: 'dead', tabs: ['dead'], callable: false, top_bar: first(1), report: report(1) }],
    // From before the Appointment side: they booked the lead and count as appointments set.
    ['sat_no_sale', { status: 'appointment_set', tabs: ['appointment_set'], callable: false, top_bar: first(1, 1), report: report(1, 1) }],
    ['sold', { status: 'appointment_set', tabs: ['appointment_set'], callable: false, top_bar: first(1, 1), report: report(1, 1) }],
  ];

  it('covers every outcome there is', () => {
    const codes = (db.prepare('SELECT code FROM outcome_code').all() as { code: string }[]).map((r) => r.code).sort();
    expect(cases.map(([c]) => c).sort()).toEqual(codes);
  });

  for (const [code, want] of cases) {
    it(code, () => {
      const got = effects(code);
      expect({ ...got, report: { ...got.report, appts_booked_or_logged: undefined } }).toMatchObject(want);
    });
  }

  it('the Reports appointments section counts appointment calls logged here', () => {
    expect(effects('appt_sale').report.appts_booked_or_logged).toBe(1);
  });


  // The Numbers page counts first calls only, like the top bar and Reports, with the same appointments set.
  const pickedUp = ['no_appt', 'appointment', 'callback', 'not_interested', 'hung_up', 'picked_up', 'other', 'dnc_request', 'sat_no_sale', 'sold'];
  const apptSet = ['appointment', 'sat_no_sale', 'sold'];
  for (const [code] of cases) {
    it(`the Numbers page: ${code}`, () => {
      expect(effects(code).numbers).toEqual({
        calls: code.startsWith('appt_') ? 0 : 1, contacts: pickedUp.includes(code) ? 1 : 0, appointments: apptSet.includes(code) ? 1 : 0,
      });
    });
  }
});
