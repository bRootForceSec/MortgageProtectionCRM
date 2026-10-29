// How an appointment in Unitrust went, read from the color of its event on the Unitrust calendar.
// The Firefox extension (extension/unitrust) reads the colors; the server stores them; the UI shows them.

/** Event colors on the Unitrust calendar. */
export type UnitrustColor = 'blue' | 'green' | 'red' | 'yellow';

/**
 * How an appointment stands. Yellow means either "sat, no sale" or "rescheduled": a rescheduled appointment moves to
 * its new day on the calendar, so a yellow event on a later day (or one whose old day lost it) is a reschedule, still
 * to come; a yellow that stays on its day is "sat, no sale".
 */
export type ApptResult = 'not_set' | 'rescheduled' | 'sold' | 'no_show' | 'sat_no_sale' | 'prezi';

export const APPT_RESULT_LABEL: Record<ApptResult, string> = {
  not_set: 'Appt booked',
  rescheduled: 'Rescheduled',
  sold: 'Sold',
  no_show: 'No-show',
  sat_no_sale: 'Sat, no sale',
  prezi: 'Prezi, no sale',
};

/** Results that put the lead back to be called. */
export const MISSED_RESULTS: readonly ApptResult[] = ['no_show', 'sat_no_sale', 'prezi'];

/**
 * The Appointment side of the Calling screen: each outcome and the result it gives the appointment.
 * "Sat, no sale" means they picked up and that's it; "Prezi" means you presented and lost them.
 */
export const APPT_OUTCOME_RESULT: Record<string, Exclude<ApptResult, 'not_set'>> = {
  appt_no_show: 'no_show',
  appt_sat_no_sale: 'sat_no_sale',
  appt_prezi: 'prezi',
  appt_sale: 'sold',
  appt_rescheduled: 'rescheduled',
};

/** The two sides of the Calling screen. */
export type CallMode = 'first_call' | 'appointment';

export interface UnitrustTitle {
  state: string;
  lender: string;
  name: string;
  phone: string;
}

/**
 * Reads a Unitrust appointment title: "OH - UNION SAVING - CALEB BRIGLE- (614) 706-9261 BRIGLE".
 * Returns null for anything else (your own events, like "Dinner at vineyard").
 */
export function parseUnitrustTitle(title: string): UnitrustTitle | null {
  const m = /^\s*([A-Z]{2})\s+-\s+(.+?)\s+-\s+(.+?)\s*-\s*\(?(\d{3})\)?[\s.-]*(\d{3,})[\s.-]*(\d{3,})/i.exec(title);
  if (!m) return null;
  return { state: m[1]!.toUpperCase(), lender: m[2]!.trim(), name: m[3]!.trim(), phone: `${m[4]}${m[5]}${m[6]}` };
}
