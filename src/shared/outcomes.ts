import type { ApptResult, CallMode } from './appointments.js';

// Every call outcome there is, and what each one means. This is the one place outcomes are defined: the server
// copies these rows into the outcome_code table each time it starts (db/outcomeCodes.ts), and lead_state, the
// call list, Reports, the funnel, the top bar, the Numbers page and the Calling screen all read from here or that table.
//
// To add an outcome, add an entry here. Never remove one that calls may carry: set `active: false` to retire it, so
// older calls keep their label and meaning. Migrations no longer touch outcome_code.

/** How an outcome went, broadly. `invalid` rules out the number that was dialed; `dead` is the dead pile. */
export type OutcomeGroup = 'no_contact' | 'contact' | 'invalid' | 'dead';

export interface OutcomeDef {
  label: string;
  /** The side of the Calling screen it belongs to. Keys 1-5 mean the outcomes of the side that is showing. */
  kind: CallMode;
  group: OutcomeGroup;
  /** Its key on that side, until you change it in Settings. */
  hotkey: string | null;
  /** They picked up: a pickup in the funnel and the top bar, a contact in Reports. */
  pickup: boolean;
  /** Sets a callback: it needs a date, and counts as a callback set. */
  callback: boolean;
  /** Sends the lead to the dead pile. */
  marksDead: boolean;
  /** Booked an appointment: the lead stays off the queue until a later call (or Unitrust) says otherwise. */
  books: boolean;
  /** Counts as "Appts set" in the funnel, the top bar, Reports and the Numbers page. */
  apptSet: boolean;
  /** Appointment side: how the appointment went. */
  apptResult: Exclude<ApptResult, 'not_set'> | null;
  /** Shown as a button. Retired outcomes stay for the calls that carry them. */
  active: boolean;
  sortOrder: number;
  introducedAt: string;
  /** Stored in outcome_code.lead_effect for older code; nothing reads it. */
  leadEffect: 'sold' | null;
}

const OCT17 = '2026-10-17T00:00:00.000Z';
const OCT29 = '2026-10-29T00:00:00.000Z';

const base = {
  kind: 'first_call', hotkey: null, pickup: false, callback: false, marksDead: false, books: false, apptSet: false,
  apptResult: null, active: true, introducedAt: OCT17, leadEffect: null,
} as const;
const retired = { ...base, active: false } as const;
const appt = { ...base, kind: 'appointment', introducedAt: OCT29 } as const;

export const OUTCOMES = {
  // First call side
  no_answer: { ...base, label: 'No answer', group: 'no_contact', hotkey: '1', sortOrder: 10 },
  no_appt: { ...base, label: 'Talked, no appt', group: 'contact', hotkey: '2', pickup: true, sortOrder: 20 },
  appointment: { ...base, label: 'Appt set', group: 'contact', hotkey: '3', pickup: true, books: true, apptSet: true, sortOrder: 30 },
  bad_number: { ...base, label: 'Bad number', group: 'invalid', hotkey: '4', sortOrder: 40 },
  callback: { ...base, label: 'Callback', group: 'contact', hotkey: '5', pickup: true, callback: true, sortOrder: 50 },

  // Appointment side
  appt_no_show: { ...appt, label: 'No show', group: 'no_contact', hotkey: '1', apptResult: 'no_show', sortOrder: 110 },
  appt_sat_no_sale: { ...appt, label: 'Sat, no sale', group: 'contact', hotkey: '2', pickup: true, apptResult: 'sat_no_sale', sortOrder: 120 },
  appt_prezi: { ...appt, label: 'Prezi', group: 'contact', hotkey: '3', pickup: true, apptResult: 'prezi', sortOrder: 130 },
  appt_sale: { ...appt, label: 'Sale', group: 'contact', hotkey: '4', pickup: true, apptResult: 'sold', leadEffect: 'sold', sortOrder: 140 },
  appt_rescheduled: { ...appt, label: 'Rescheduled', group: 'contact', hotkey: '5', pickup: true, apptResult: 'rescheduled', sortOrder: 150 },

  // Retired. Older calls (and spreadsheet history) still carry them.
  vm_left: { ...retired, label: 'Voicemail, message left', group: 'no_contact', sortOrder: 20 },
  vm_no_msg: { ...retired, label: 'Voicemail, no message', group: 'no_contact', sortOrder: 30 },
  busy: { ...retired, label: 'Busy', group: 'no_contact', sortOrder: 40 },
  dnc_request: { ...retired, label: 'Do not call', group: 'dead', pickup: true, marksDead: true, sortOrder: 40 },
  not_interested: { ...retired, label: 'Not interested', group: 'contact', pickup: true, sortOrder: 50 },
  wrong_person: { ...retired, label: 'Wrong person', group: 'invalid', sortOrder: 90 },
  hung_up: { ...retired, label: 'Answered, hung up', group: 'contact', pickup: true, sortOrder: 95 },
  other: { ...retired, label: 'Other (add a note)', group: 'contact', pickup: true, sortOrder: 100 },
  picked_up: { ...retired, label: 'Picked up', group: 'contact', pickup: true, sortOrder: 120 },
  // From before the Appointment side: each one booked the lead, so it counts as an appointment set.
  sat_no_sale: { ...retired, label: 'Appointment sat, no sale', group: 'contact', pickup: true, books: true, apptSet: true, sortOrder: 130 },
  sold: { ...retired, label: 'Sold', group: 'contact', pickup: true, books: true, apptSet: true, leadEffect: 'sold', sortOrder: 140 },
} as const satisfies Record<string, OutcomeDef>;

export type OutcomeCode = keyof typeof OUTCOMES;

const entries = Object.entries(OUTCOMES) as [OutcomeCode, OutcomeDef][];

/** The outcome codes for which `test` holds. */
export function outcomeCodes(test: (o: OutcomeDef) => boolean): OutcomeCode[] {
  return entries.filter(([, o]) => test(o)).map(([c]) => c);
}

/** The definition of a code, or undefined for a code that isn't one. */
export function outcomeDef(code: string | null | undefined): OutcomeDef | undefined {
  return code && Object.hasOwn(OUTCOMES, code) ? OUTCOMES[code as OutcomeCode] : undefined;
}

/** Outcomes that mean the lead booked an appointment. */
export const BOOKED_CODES: ReadonlySet<string> = new Set(outcomeCodes((o) => o.books));

/** The Appointment side: each outcome and the result it gives the appointment. */
export const APPT_OUTCOME_RESULT: Readonly<Record<string, Exclude<ApptResult, 'not_set'>>> = Object.fromEntries(
  entries.flatMap(([c, o]) => (o.apptResult ? [[c, o.apptResult]] : [])),
);

/**
 * Saves as soon as you press its key, without Enter. By default that's the outcomes with nothing more to fill in (no
 * callback time, no talk time); `chosen` (Settings, outcome code -> on/off) changes any of them except a callback,
 * which always needs its day.
 */
export function savesInstantly(
  o: { code: string; requires_callback_time: number | boolean; counts_as_human_contact: number | boolean },
  chosen: Readonly<Record<string, boolean>> = {},
): boolean {
  if (o.requires_callback_time) return false;
  return Object.hasOwn(chosen, o.code) ? chosen[o.code]! : !o.counts_as_human_contact;
}

