// How an appointment in Unitrust went, read from the color of its event on the Unitrust calendar.
// The Firefox extension (extension/unitrust) reads the colors; the server stores them; the UI shows them.

/** Event colors on the Unitrust calendar. */
export type UnitrustColor = 'blue' | 'green' | 'red' | 'yellow';

/** What a color means. Yellow is either a reschedule or "sat, no sale": Unitrust doesn't tell them apart. */
export type ApptResult = 'not_set' | 'sold' | 'no_show' | 'follow_up';

export const RESULT_FOR_COLOR: Record<UnitrustColor, ApptResult> = { blue: 'not_set', green: 'sold', red: 'no_show', yellow: 'follow_up' };

export const APPT_RESULT_LABEL: Record<ApptResult, string> = {
  not_set: 'Appt booked',
  sold: 'Sold',
  no_show: 'No-show',
  follow_up: 'Resched / no sale',
};

/** Results that put the lead back to be called. */
export const MISSED_RESULTS: readonly ApptResult[] = ['no_show', 'follow_up'];

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
