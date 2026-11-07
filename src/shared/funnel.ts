import * as z from 'zod/v4';
import { APPT_RESULTS } from './appointments.js';
import { outcomeDef } from './outcomes.js';

// The funnel, top to bottom. These seven are the counts the CRM keeps itself: dials, leads called, pickups and
// appointments set count first calls; sat, prezis and sales count appointments, on their day.
//
// Your funnel (Settings → Your day, "Funnel"; the setting `funnel_steps`) is a list of steps, each one of these counts
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
]);
export type FunnelCount = z.infer<typeof FunnelCount>;

export const FunnelStepDef = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'give the step a name').max(40),
  count: FunnelCount,
});
export type FunnelStepDef = z.infer<typeof FunnelStepDef>;

export const FunnelSteps = z
  .array(FunnelStepDef)
  .min(1, 'the funnel needs at least one step')
  .max(12)
  .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, 'two steps have the same id');

/** Today's seven, as your funnel starts. */
export const STARTER_FUNNEL: FunnelStepDef[] = FUNNEL_STEPS.map((s) => ({ id: s.key, name: s.label, count: { by: 'measure', measure: s.key } }));

/** Where a step's number comes from, in words. */
export function describeFunnelCount(c: FunnelCount): string {
  return c.by === 'measure' ? `${FUNNEL_LABEL[c.measure]} (kept by the CRM)` : c.formula;
}
