// Follow-up plans: after a no-show, a sat-no-sale or a prezi, when to try the lead again. Each step is how long after
// the appointment result (the first step) or the last unanswered try (later steps) the lead comes due, as a callback
// you can change. Once the steps run out, or someone answers, the lead goes back to the usual retry gap.
//
// A step is written "15m", "2h", "3d", or "1d@09:00" (that many days later, at that time of day, in your time).

import type { ApptResult } from './appointments.js';

export const STEP = /^(\d{1,4})(m|h|d)(?:@([01]\d|2[0-3]):([0-5]\d))?$/;

/** The results that put a lead back to be called and can have a plan. */
export type FollowUpResult = Extract<ApptResult, 'no_show' | 'sat_no_sale' | 'prezi'>;
export type FollowUpPlans = Partial<Record<FollowUpResult, string[]>>;

/** Plans start empty (due right away, as before); these are offered in Settings as a starting point. */
export const SUGGESTED_FOLLOW_UPS: Required<FollowUpPlans> = {
  no_show: ['15m', '1d@09:00', '3d'],
  sat_no_sale: ['1d@10:00', '3d'],
  prezi: ['2d', '7d'],
};

/** Whether a step is written in a way the plan understands ("@" only goes with days). */
export function isStep(s: string): boolean {
  const m = STEP.exec(s);
  return !!m && (m[3] === undefined || m[2] === 'd');
}

/** When a step comes due after `fromIso`. Days keep the clock time (or move to the "@" time) across daylight saving. */
export function afterStep(fromIso: string, step: string): string {
  const m = STEP.exec(step);
  if (!m) throw new Error(`not a follow-up step: ${step}`);
  const n = Number(m[1]);
  const d = new Date(fromIso);
  if (m[2] === 'm') return new Date(d.getTime() + n * 60_000).toISOString();
  if (m[2] === 'h') return new Date(d.getTime() + n * 3_600_000).toISOString();
  d.setDate(d.getDate() + n);
  if (m[3] !== undefined) d.setHours(Number(m[3]), Number(m[4]), 0, 0);
  return d.toISOString();
}

/** "15m, 1d@09:00, 3d" -> ['15m', '1d@09:00', '3d']; null when a step isn't understood. */
export function parsePlan(text: string): string[] | null {
  const steps = text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return steps.every(isStep) ? steps : null;
}
