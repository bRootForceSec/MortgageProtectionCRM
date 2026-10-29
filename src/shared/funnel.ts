import { APPT_RESULTS } from './appointments.js';
import { outcomeDef } from './outcomes.js';

// The funnel, top to bottom. The top bar, the funnel graphic and Reports use these names. Dials, leads called, pickups
// and appointments set count first calls; sat, prezis and sales count appointments, on their day.

export type FunnelStep = 'dials' | 'leads_called' | 'pickups' | 'appts_set' | 'sat' | 'prezis' | 'sales';

export const FUNNEL_STEPS: readonly { key: FunnelStep; label: string }[] = [
  { key: 'dials', label: 'Dials' },
  { key: 'leads_called', label: 'Leads called' },
  { key: 'pickups', label: 'Pickups' },
  { key: 'appts_set', label: 'Appts set' },
  { key: 'sat', label: 'Sat' },
  { key: 'prezis', label: 'Prezis' },
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
