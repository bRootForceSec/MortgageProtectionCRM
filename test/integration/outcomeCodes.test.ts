import { describe, it, expect } from 'vitest';
import { tempDb } from '../helpers.js';

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

describe('outcome codes', () => {
  it('match what the migrations leave', () => {
    const { db } = tempDb();
    const got = db.prepare('SELECT code, label, grp, kind, hotkey, counts_as_human_contact, requires_callback_time, marks_dead, sort_order, active, lead_effect, introduced_at, retired_at FROM outcome_code ORDER BY sort_order, code').all();
    const want = [...ROWS].sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
    expect(got).toEqual(want);
  });
});
