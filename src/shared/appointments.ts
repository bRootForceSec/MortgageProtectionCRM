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

export interface ApptResultDef {
  /** On the badge beside a lead. */
  label: string;
  /** Puts the lead back to be called, to set it up again. */
  missed: boolean;
  /** Its tab on the Leads page (leads whose latest appointment went this way), if it has one. */
  tab: { key: string; label: string; title: string } | null;
  /** The funnel steps below "Appts set" that it reaches. */
  funnel: readonly ('sat' | 'prezis' | 'sales')[];
  /** The Unitrust color that means it, when one color does (yellow is sat-no-sale or rescheduled). */
  color: UnitrustColor | null;
}

/** Every appointment result, in the order the Leads page tabs show them. */
export const APPT_RESULTS: Record<ApptResult, ApptResultDef> = {
  not_set: { label: 'Appt booked', missed: false, tab: null, funnel: [], color: 'blue' },
  rescheduled: { label: 'Rescheduled', missed: false, tab: null, funnel: [], color: null },
  no_show: {
    label: 'No-show', missed: true, funnel: [], color: 'red',
    tab: { key: 'appt_no_show', label: 'No-shows', title: 'Their latest appointment was a no-show (logged here, or red in Unitrust)' },
  },
  sat_no_sale: {
    label: 'Sat, no sale', missed: true, funnel: ['sat'], color: null,
    tab: { key: 'appt_sat_no_sale', label: 'Sat, no sale', title: 'Picked up for their latest appointment, no presentation (logged here, or yellow in Unitrust)' },
  },
  prezi: {
    label: 'Prezi, no sale', missed: true, funnel: ['sat', 'prezis'], color: null,
    tab: { key: 'appt_prezi', label: 'Prezis', title: 'You presented at their latest appointment and lost them' },
  },
  sold: {
    label: 'Sold', missed: false, funnel: ['sat', 'prezis', 'sales'], color: 'green',
    tab: { key: 'appt_sold', label: 'Sold', title: 'Their latest appointment was a sale (logged here, or green in Unitrust)' },
  },
};

const results = Object.entries(APPT_RESULTS) as [ApptResult, ApptResultDef][];

export const APPT_RESULT_LABEL = Object.fromEntries(results.map(([r, d]) => [r, d.label])) as Record<ApptResult, string>;

/** Results that put the lead back to be called. */
export const MISSED_RESULTS: readonly ApptResult[] = results.filter(([, d]) => d.missed).map(([r]) => r);

/** The result a Unitrust color means on its own (yellow needs the calendar around it, so it isn't here). */
export function resultOfColor(color: UnitrustColor): ApptResult | null {
  return results.find(([, d]) => d.color === color)?.[0] ?? null;
}

/** Whether a stored value is an appointment result. */
export function isApptResult(v: string | null | undefined): v is ApptResult {
  return !!v && Object.hasOwn(APPT_RESULTS, v);
}

/** The two sides of the Calling screen. */
export type CallMode = 'first_call' | 'appointment';

/**
 * Which side of the Calling screen a lead opens on: Appointment when it has an appointment booked (or rescheduled)
 * with no result yet, from Appt set or from Unitrust; otherwise First call.
 */
export function openingSide(state: { status: string; appt_result: string | null } | null | undefined): CallMode {
  return state?.status === 'appointment_set' && state.appt_result !== 'sold' ? 'appointment' : 'first_call';
}

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
