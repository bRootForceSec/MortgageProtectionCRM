import * as z from 'zod/v4';
import { APPT_RESULTS } from './appointments.js';
import { outcomeDef } from './outcomes.js';
import { STATUS_COLORS } from './statuses.js';

// The funnel, top to bottom. These seven are the counts the CRM keeps itself: dials, leads called, pickups and
// appointments set count first calls; sat, prezis and sales count appointments, on their day.
//
// Your funnel (Automation, "Funnel"; the setting `funnel_steps`) is a list of steps, each one of these counts
// or a formula of your own over the log: a number added up over your leads (like times("Hot")) or a yes/no that
// counts the leads it's true for. In a funnel step, the log functions (times, pressed, added, removed, before) only
// see the period being counted. The top bar and the funnel graphic show your steps in your order.

export type FunnelStep = 'dials' | 'leads_called' | 'pickups' | 'appts_set' | 'sat' | 'prezis' | 'sales';

export const FUNNEL_STEPS: readonly { key: FunnelStep; label: string }[] = [
  { key: 'dials', label: 'Dials' },
  { key: 'leads_called', label: 'Leads called' },
  { key: 'pickups', label: 'Pickups' },
  { key: 'appts_set', label: 'Appts set' },
  { key: 'sat', label: 'Sat' },
  { key: 'prezis', label: 'Presentations' },
  { key: 'sales', label: 'Sales' },
];

export const FUNNEL_LABEL = Object.fromEntries(FUNNEL_STEPS.map((s) => [s.key, s.label])) as Record<FunnelStep, string>;

/** The steps below "Leads called" that one call with this outcome reaches. */
export function funnelStepsOf(code: string): FunnelStep[] {
  const o = outcomeDef(code);
  if (!o) return [];
  if (o.kind === 'appointment') return o.apptResult ? [...APPT_RESULTS[o.apptResult].funnel] : [];
  return [...(o.pickup ? ['pickups' as const] : []), ...(o.apptSet ? ['appts_set' as const] : [])];
}

export const FunnelCount = z.discriminatedUnion('by', [
  z.object({ by: z.literal('measure'), measure: z.enum(['dials', 'leads_called', 'pickups', 'appts_set', 'sat', 'prezis', 'sales']) }),
  z.object({ by: z.literal('formula'), formula: z.string().trim().min(1, 'a funnel step needs a formula').max(2000) }),
  z.object({ by: z.literal('tag'), tag: z.string().trim().min(1, 'pick a tag').max(40) }),
  z.object({ by: z.literal('list'), list: z.string().trim().min(1, 'pick a smart list').max(40) }),
]);
export type FunnelCount = z.infer<typeof FunnelCount>;

export const FunnelStepDef = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'give the step a name').max(40),
  count: FunnelCount,
  /** Its glow in the funnel graphic. Left out: the count's own, or the smart list's color for a step that counts one. */
  color: z.enum(STATUS_COLORS).optional(),
});
export type FunnelStepDef = z.infer<typeof FunnelStepDef>;

export const FunnelSteps = z
  .array(FunnelStepDef)
  .min(1, 'the funnel needs at least one step')
  .max(12)
  .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, 'two steps have the same id');

/** Today's seven, as your funnel starts. */
export const STARTER_FUNNEL: FunnelStepDef[] = FUNNEL_STEPS.map((s) => ({ id: s.key, name: s.label, count: { by: 'measure', measure: s.key } }));

/** A name in quotes for a formula (there are no escapes, so a name with " in it goes in single quotes). */
const quote = (name: string) => (name.includes('"') ? `'${name}'` : `"${name}"`);

/**
 * The formula a step is counted by, or null for one the CRM keeps. A tag step counts each time the tag was put on in
 * the period, times("Tag"); a smart list step counts the leads in it now, in_list("List").
 */
export function stepFormula(c: FunnelCount): string | null {
  switch (c.by) {
    case 'measure': return null;
    case 'formula': return c.formula;
    case 'tag': return `times(${quote(c.tag)})`;
    case 'list': return `in_list(${quote(c.list)})`;
  }
}

/** Where a step's number comes from, in words. */
export function describeFunnelCount(c: FunnelCount): string {
  switch (c.by) {
    case 'measure': return `${FUNNEL_LABEL[c.measure]} (kept by the CRM)`;
    case 'formula': return c.formula;
    case 'tag': return `Times the tag "${c.tag}" was put on a lead in the period`;
    case 'list': return `Leads in the smart list "${c.list}" now`;
  }
}
