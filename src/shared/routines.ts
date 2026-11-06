import * as z from 'zod/v4';
import { APPT_DAYS, IMPORTED_WHEN, LAST_CALL, LeadQuery, gapLabel } from './leadFilter.js';
import { LEAD_TABS } from './leadStatus.js';
import { AGE_BANDS } from './leadAge.js';

// Daily routines: the order you call in on a day, as steps, set up in Settings → Calling. A step is a Leads filter
// (kept as its query, so "today" means today every day) or a saved call list. The Calling screen offers each step in
// turn; you choose each time whether its leads go under the list or replace it.

export const STEP_ORDERS = { set: 'As set', best_time: 'Best time first' } as const;
export type StepOrder = keyof typeof STEP_ORDERS;

export const StepSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('filter'), filter: LeadQuery.partial() }),
  z.object({ kind: z.literal('saved_list'), list_id: z.string().min(1).max(64) }),
]);
export type StepSource = z.infer<typeof StepSource>;

export const RoutineStep = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'give the step a name').max(60),
  order: z.enum(['set', 'best_time']).default('set'),
  source: StepSource,
});
export type RoutineStep = z.infer<typeof RoutineStep>;

export const Routine = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'give the routine a name').max(60),
  /** Days of the week it runs: 0 is Sunday, 6 is Saturday (Date.getDay). */
  days: z.array(z.number().int().min(0).max(6)).max(7),
  steps: z.array(RoutineStep).max(20),
});
export type Routine = z.infer<typeof Routine>;

export const Routines = z.array(Routine).max(20);

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Ready-made steps to start from, for the routine you described: no-shows, the morning's imports, then no-answers. */
export const STARTER_STEPS: readonly Omit<RoutineStep, 'id'>[] = [
  {
    name: 'No-shows',
    order: 'best_time',
    source: { kind: 'filter', filter: { status: 'appt_no_show', appt_days: 'since_last_calling_day', last_call: 'not_today' } },
  },
  { name: "Today's imports", order: 'set', source: { kind: 'filter', filter: { status: 'new', imported: 'today' } } },
  { name: "Yesterday's leftovers", order: 'set', source: { kind: 'filter', filter: { status: 'new', imported: 'yesterday' } } },
  { name: "Today's no-answers", order: 'best_time', source: { kind: 'filter', filter: { status: 'no_answer', last_call: 'today', not_within_min: 60 } } },
];

/** The routine a new install starts with, every day. Change or delete it in Settings. */
export function starterRoutine(newId: () => string): Routine {
  const pick = (name: string) => ({ ...STARTER_STEPS.find((s) => s.name === name)!, id: newId() });
  return { id: newId(), name: 'Every day', days: [0, 1, 2, 3, 4, 5, 6], steps: [pick('No-shows'), pick("Today's imports"), pick("Today's no-answers")] };
}

/** The routines that run on a day of the week, in the order you listed them. */
export function routinesOn(routines: readonly Routine[], weekday: number): Routine[] {
  return routines.filter((r) => r.days.includes(weekday));
}

/** Today's routine as the Calling screen shows it (GET /api/routine/today). */
export interface StepToday {
  id: string;
  name: string;
  order: StepOrder;
  kind: RoutineStep['source']['kind'];
  /** Leads it would add now (callable ones not already waiting on the list); null when its saved list is gone. */
  count: number | null;
  /** The appointment-day choice of a no-shows step, for the blue-appointments reminder. */
  appt_days: string | null;
  started_at: string | null;
  /** Of the leads it added when started: how many, and how many you've called since. */
  total: number;
  called: number;
}

export interface RoutineToday {
  day: string;
  routine: { id: string; name: string } | null;
  /** Every routine, to switch to another for today; `today` when it runs on this weekday. */
  choices: { id: string; name: string; today: boolean }[];
  steps: StepToday[];
}

/** A step's filter in words, e.g. "No answer · Last call today · Not dialed in the last 1 hour". */
export function describeFilter(f: Partial<LeadQuery>): string {
  const label = <T extends { key: string; label: string }>(list: readonly T[], key: string | undefined) => (key ? list.find((x) => x.key === key)?.label ?? key : null);
  const lists = (v: string | undefined, one: string, many: string) => {
    const n = v ? v.split(',').filter(Boolean).length : 0;
    return n ? `${n} ${n === 1 ? one : many}` : null;
  };
  return [
    f.status && f.status !== 'all' ? label(LEAD_TABS, f.status) ?? (f.status === 'appt_missed' ? 'Missed appointments' : f.status) : 'All leads',
    label(IMPORTED_WHEN, f.imported),
    label(APPT_DAYS, f.appt_days),
    label(LAST_CALL, f.last_call),
    f.not_within_min ? `Not dialed in the last ${gapLabel(f.not_within_min)}` : null,
    f.lead_type ? (f.lead_type === 'none' ? 'No lead type' : `Lead type ${f.lead_type}`) : null,
    f.age ? (f.age === 'unknown' ? 'No call-in date' : `Age ${label(AGE_BANDS, f.age)}`) : null,
    f.batch_id || f.bulk_id ? 'One import' : null,
    lists(f.counties, 'county', 'counties'),
    lists(f.area_codes, 'area code', 'area codes'),
    f.search ? `Search "${f.search}"` : null,
    f.not_on_list === '1' || f.not_on_list === true ? 'Not on the call list' : null,
  ].filter(Boolean).join(' · ');
}
