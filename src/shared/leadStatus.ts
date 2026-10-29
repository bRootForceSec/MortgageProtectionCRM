import { APPT_RESULTS } from './appointments.js';

// How a lead stands (lead_state.status), and the Leads page tabs built on it. The one place these are defined:
// lead_state, the call list, Reports, the Leads page and the Calling screen read from here.

export type LeadStatus = 'new' | 'retry' | 'callback' | 'appointment_set' | 'invalid' | 'dead';

export interface LeadStatusDef {
  /** On the badge beside a lead. */
  label: string;
  /** Can go on the call list and be dialed. The rest have to be restored first. */
  callable: boolean;
  /** Stays put until something happens to the lead (a retry becomes due as time passes). */
  timeless: boolean;
}

export const LEAD_STATUSES: Record<LeadStatus, LeadStatusDef> = {
  new: { label: 'New', callable: true, timeless: true },
  retry: { label: 'Tried', callable: true, timeless: false },
  callback: { label: 'Callback', callable: true, timeless: true },
  appointment_set: { label: 'Appointment set', callable: false, timeless: true },
  invalid: { label: 'Bad number', callable: false, timeless: true },
  dead: { label: 'Dead lead', callable: false, timeless: true },
};

const statuses = Object.entries(LEAD_STATUSES) as [LeadStatus, LeadStatusDef][];

/** Statuses that can go on the call list. */
export const CALLABLE_STATUSES: readonly LeadStatus[] = statuses.filter(([, d]) => d.callable).map(([s]) => s);

export function isCallable(status: string | null | undefined): boolean {
  return !!status && Object.hasOwn(LEAD_STATUSES, status) && LEAD_STATUSES[status as LeadStatus].callable;
}

export function statusLabel(status: string): string {
  return Object.hasOwn(LEAD_STATUSES, status) ? LEAD_STATUSES[status as LeadStatus].label : status;
}

export interface LeadTab {
  key: string;
  label: string;
  title?: string;
}

/** The Leads page tabs, in order. One per way a lead can stand, matching the outcome keys on the Calling screen. */
export const LEAD_TABS: readonly LeadTab[] = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'Never called' },
  { key: 'no_answer', label: 'No answer', title: 'Called, but the last call didn\'t reach them' },
  { key: 'talked', label: 'Talked, no appt' },
  { key: 'callback', label: 'Callbacks' },
  { key: 'appointment_set', label: 'Appointment set', title: 'Booked, rescheduled or sold' },
  // How the latest appointment went, whatever the lead's status now.
  ...Object.values(APPT_RESULTS).flatMap((r) => (r.tab ? [r.tab] : [])),
  { key: 'invalid', label: 'Bad numbers' },
  { key: 'dead', label: 'Dead pile' },
];

/** Everything the Leads filter accepts: the tabs, plus leads an appointment result put back to be called. */
export const LEAD_FILTERS: [string, ...string[]] = ['appt_missed', 'retry', ...LEAD_TABS.map((t) => t.key)];
