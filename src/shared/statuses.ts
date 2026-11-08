import * as z from 'zod/v4';

// Your statuses: a status is a name for a condition (Python syntax, a yes/no formula), like "Needs rebook =
// has("No show") and not has("Appt set")". A lead is in every status whose condition is true for it, worked out
// when asked, never stored. A condition can use another status: status("Needs rebook"). Kept as the `statuses`
// setting (domain/statuses.ts). Statuses show as badges, in your order (the first one wins where only one fits), and
// any you pick show as Leads tabs.

export const STATUS_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple'] as const;
export type StatusColor = (typeof STATUS_COLORS)[number];

export const Status = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'give the status a name').max(40, 'keep the name under 40 characters'),
  condition: z.string().trim().min(1, 'give the status a condition').max(2000),
  color: z.enum(STATUS_COLORS).default('gray'),
  /** Shown as a tab on the Leads page. */
  tab: z.boolean().default(false),
});
export type Status = z.infer<typeof Status>;

export const Statuses = z.array(Status).max(100);

/**
 * The smart lists you start with: the ways a lead can stand, which were fixed tabs on Leads before. Each is a
 * condition you can change, rename, recolor or delete; all show as Leads tabs.
 */
export const STARTER_LISTS: readonly Omit<Status, 'id'>[] = [
  { name: 'Never called', condition: 'status == "new"', color: 'blue', tab: true },
  { name: 'No answer', condition: 'status == "retry" and not picked_up and not put_back', color: 'gray', tab: true },
  { name: 'Picked up, no appt', condition: 'status == "retry" and picked_up and not put_back', color: 'yellow', tab: true },
  { name: 'Callbacks', condition: 'status == "callback"', color: 'purple', tab: true },
  { name: 'Appointment set', condition: 'status == "appointment_set"', color: 'green', tab: true },
  { name: 'No-shows', condition: 'appt_result == "no_show"', color: 'red', tab: true },
  { name: 'Appt picked up', condition: 'appt_result == "sat_no_sale"', color: 'orange', tab: true },
  { name: 'Presentations', condition: 'appt_result == "prezi"', color: 'orange', tab: true },
  { name: 'Sold', condition: 'appt_result == "sold"', color: 'green', tab: true },
  { name: 'Bad numbers', condition: 'status == "invalid"', color: 'gray', tab: true },
  { name: 'Dead pile', condition: 'status == "dead"', color: 'gray', tab: true },
];

/** A status as the UI gets it: with how many leads are in it now (null when its condition has a mistake). */
export interface StatusInfo extends Status {
  leads: number | null;
  error: string | null;
}

/** The statuses a lead is in, as badges. */
export interface StatusBadge {
  id: string;
  name: string;
  color: StatusColor;
}
