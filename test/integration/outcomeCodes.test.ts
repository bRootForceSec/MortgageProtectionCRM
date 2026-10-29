import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { tempDb } from '../helpers.js';
import { migrate } from '../../src/server/db/connection.js';
import { outcomeRow, sqlCodes, syncOutcomeCodes } from '../../src/server/db/outcomeCodes.js';
import { APPT_OUTCOME_RESULT, BOOKED_CODES, OUTCOMES, outcomeDef, savesInstantly } from '../../src/shared/outcomes.js';

// Characterization: the outcome_code table after every migration has run, on a new database (and so on every
// existing one, since they ran the same migrations). The calling screen, Reports, the funnel and lead_state all
// read these rows.
const ROWS = [
  { code: 'no_answer', label: 'No answer', grp: 'no_contact', kind: 'first_call', hotkey: '1', counts_as_human_contact: 0, requires_callback_time: 0, marks_dead: 0, sort_order: 10, active: 1, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'vm_left', label: 'Voicemail, message left', grp: 'no_contact', kind: 'first_call', hotkey: null, counts_as_human_contact: 0, requires_callback_time: 0, marks_dead: 0, sort_order: 20, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'no_appt', label: 'Talked, no appt', grp: 'contact', kind: 'first_call', hotkey: '2', counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 20, active: 1, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'vm_no_msg', label: 'Voicemail, no message', grp: 'no_contact', kind: 'first_call', hotkey: null, counts_as_human_contact: 0, requires_callback_time: 0, marks_dead: 0, sort_order: 30, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'appointment', label: 'Appt set', grp: 'contact', kind: 'first_call', hotkey: '3', counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 30, active: 1, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'busy', label: 'Busy', grp: 'no_contact', kind: 'first_call', hotkey: null, counts_as_human_contact: 0, requires_callback_time: 0, marks_dead: 0, sort_order: 40, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'bad_number', label: 'Bad number', grp: 'invalid', kind: 'first_call', hotkey: '4', counts_as_human_contact: 0, requires_callback_time: 0, marks_dead: 0, sort_order: 40, active: 1, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'dnc_request', label: 'Do not call', grp: 'dead', kind: 'first_call', hotkey: null, counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 1, sort_order: 40, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'not_interested', label: 'Not interested', grp: 'contact', kind: 'first_call', hotkey: null, counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 50, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'callback', label: 'Callback', grp: 'contact', kind: 'first_call', hotkey: '5', counts_as_human_contact: 1, requires_callback_time: 1, marks_dead: 0, sort_order: 50, active: 1, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'wrong_person', label: 'Wrong person', grp: 'invalid', kind: 'first_call', hotkey: null, counts_as_human_contact: 0, requires_callback_time: 0, marks_dead: 0, sort_order: 90, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'hung_up', label: 'Answered, hung up', grp: 'contact', kind: 'first_call', hotkey: null, counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 95, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'other', label: 'Other (add a note)', grp: 'contact', kind: 'first_call', hotkey: null, counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 100, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'appt_no_show', label: 'No show', grp: 'no_contact', kind: 'appointment', hotkey: '1', counts_as_human_contact: 0, requires_callback_time: 0, marks_dead: 0, sort_order: 110, active: 1, lead_effect: null, introduced_at: '2026-10-29T00:00:00.000Z', retired_at: null },
  { code: 'picked_up', label: 'Picked up', grp: 'contact', kind: 'first_call', hotkey: null, counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 120, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'appt_sat_no_sale', label: 'Sat, no sale', grp: 'contact', kind: 'appointment', hotkey: '2', counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 120, active: 1, lead_effect: null, introduced_at: '2026-10-29T00:00:00.000Z', retired_at: null },
  { code: 'sat_no_sale', label: 'Appointment sat, no sale', grp: 'contact', kind: 'first_call', hotkey: null, counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 130, active: 0, lead_effect: null, introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'appt_prezi', label: 'Prezi', grp: 'contact', kind: 'appointment', hotkey: '3', counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 130, active: 1, lead_effect: null, introduced_at: '2026-10-29T00:00:00.000Z', retired_at: null },
  { code: 'sold', label: 'Sold', grp: 'contact', kind: 'first_call', hotkey: null, counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 140, active: 0, lead_effect: 'sold', introduced_at: '2026-10-17T00:00:00.000Z', retired_at: null },
  { code: 'appt_sale', label: 'Sale', grp: 'contact', kind: 'appointment', hotkey: '4', counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 140, active: 1, lead_effect: 'sold', introduced_at: '2026-10-29T00:00:00.000Z', retired_at: null },
  { code: 'appt_rescheduled', label: 'Rescheduled', grp: 'contact', kind: 'appointment', hotkey: '5', counts_as_human_contact: 1, requires_callback_time: 0, marks_dead: 0, sort_order: 150, active: 1, lead_effect: null, introduced_at: '2026-10-29T00:00:00.000Z', retired_at: null },
];

const COLS = 'code, label, grp, kind, hotkey, counts_as_human_contact, requires_callback_time, marks_dead, sort_order, active, lead_effect, introduced_at, retired_at';
const byOrder = (rows: { code: string; sort_order: number }[]) => [...rows].sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
const MIGRATIONS = path.join(import.meta.dirname, '../../src/server/db/migrations');

describe('outcome codes', () => {
  it('match what the migrations leave', () => {
    const { db } = tempDb();
    expect(db.prepare(`SELECT ${COLS} FROM outcome_code ORDER BY sort_order, code`).all()).toEqual(byOrder(ROWS));
  });

  it('the registry gives exactly the rows the migrations left, so opening an existing database changes nothing', () => {
    expect(byOrder(Object.entries(OUTCOMES).map(([c, o]) => outcomeRow(c, o)))).toEqual(byOrder(ROWS));
    const db = new Database(':memory:');
    migrate(db);
    expect(syncOutcomeCodes(db)).toBe(0);
  });

  it('the registry wins over the table, and adds what is missing', () => {
    const { db } = tempDb();
    db.prepare("UPDATE outcome_code SET label = 'Changed', hotkey = '9' WHERE code = 'no_answer'").run();
    db.prepare("DELETE FROM outcome_code WHERE code = 'appt_rescheduled'").run();
    expect(syncOutcomeCodes(db)).toBe(2);
    expect(syncOutcomeCodes(db)).toBe(0);
    expect(db.prepare(`SELECT ${COLS} FROM outcome_code ORDER BY sort_order, code`).all()).toEqual(byOrder(ROWS));
  });

  it('migrations after 021 leave outcome_code to the registry', () => {
    // Filenames sort by number; '021_~' sorts after every 021_ name.
    const late = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f > '021_~');
    for (const f of late) expect(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'), f).not.toMatch(/outcome_code/);
  });

  it('what the registry derives', () => {
    expect([...BOOKED_CODES].sort()).toEqual(['appointment', 'sat_no_sale', 'sold']);
    expect(APPT_OUTCOME_RESULT).toEqual({
      appt_no_show: 'no_show', appt_sat_no_sale: 'sat_no_sale', appt_prezi: 'prezi', appt_sale: 'sold', appt_rescheduled: 'rescheduled',
    });
    expect(sqlCodes((o) => o.apptSet)).toBe("('appointment', 'sat_no_sale', 'sold')");
    expect(sqlCodes((o) => o.callback)).toBe("('callback')");
    expect(sqlCodes(() => false)).toBe('(NULL)');
    expect(outcomeDef('toString')).toBeUndefined();
    expect(outcomeDef('callback')?.label).toBe('Callback');
    // No answer, Bad number and No show save as soon as you press the key.
    const instant = Object.entries(OUTCOMES).filter(([, o]) => o.active && savesInstantly(outcomeRow('', o))).map(([c]) => c);
    expect(instant).toEqual(['no_answer', 'bad_number', 'appt_no_show']);
  });

  it('Settings can change which outcomes save without Enter, except a callback', () => {
    const row = (code: string) => outcomeRow(code, OUTCOMES[code as keyof typeof OUTCOMES]);
    const chosen = { no_appt: true, no_answer: false, callback: true };
    expect(savesInstantly(row('no_appt'), chosen)).toBe(true);
    expect(savesInstantly(row('no_answer'), chosen)).toBe(false);
    expect(savesInstantly(row('callback'), chosen)).toBe(false);
    expect(savesInstantly(row('bad_number'), chosen)).toBe(true);
    expect(savesInstantly(row('appt_sat_no_sale'), chosen)).toBe(false);
  });
});
