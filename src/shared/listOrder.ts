import * as z from 'zod/v4';
import { MISSED_RESULTS } from './appointments.js';
import { bestTimeScore, type BestTimes } from './bestTime.js';

// "Your order" on the call list (Settings → Calling, "Call list order"): sort steps, the first that tells two leads
// apart decides. A step is "best time now" or a formula: a yes/no puts the leads it's true for first, a number puts the
// highest first (`lowest_first` turns either around). Leads every step ties keep the order they're in on the list. The server works out
// each formula step for each lead (`sort_keys` on the call list); this file sorts with them, so the best-time step
// uses the time it is now.

/** The Order buttons on the Calling screen. */
export const LIST_ORDERS = { set: 'As set', best_time: 'Best time first', yours: 'Your order' } as const;
export type ListOrder = keyof typeof LIST_ORDERS;

export const SortStep = z.discriminatedUnion('by', [
  z.object({ by: z.literal('best_time') }),
  z.object({
    by: z.literal('formula'),
    formula: z.string().trim().min(1, 'a sort step needs a formula').max(2000),
    /** Turned around: lowest number first, or for a yes/no, the leads it's false for first. */
    lowest_first: z.boolean().default(false),
  }),
]);
export type SortStep = z.infer<typeof SortStep>;

/** As you start: leads an appointment put back (no-show, picked up, presentation), then the best time to call now. */
export const STARTER_ORDER: SortStep[] = [
  { by: 'formula', formula: MISSED_RESULTS.map((r) => `appt_result == "${r}"`).join(' or '), lowest_first: false },
  { by: 'best_time' },
];

export function describeSortStep(s: SortStep): string {
  if (s.by === 'best_time') return 'Best time to call now';
  return s.lowest_first ? `${s.formula} (lowest first)` : s.formula;
}

/**
 * The list in your order: leads still to call sorted by the steps, then the worked ones as they are. `sort_keys` has
 * one value per step (null for best time, and where a formula has no value, which goes last).
 */
export function yourOrder<T extends { done: unknown; time_zone: string | null; sort_keys: (number | null)[] }>(
  items: T[],
  steps: readonly SortStep[],
  times: BestTimes,
  now = new Date(),
): T[] {
  const keyed = items
    .filter((i) => !i.done)
    .map((i, n) => ({
      i,
      n,
      k: steps.map((s, j) => {
        if (s.by === 'best_time') return bestTimeScore(times, i.time_zone, now);
        const v = i.sort_keys[j] ?? null;
        return v == null ? null : s.lowest_first ? -v : v;
      }),
    }));
  keyed.sort((a, b) => {
    for (let j = 0; j < steps.length; j++) {
      const x = a.k[j], y = b.k[j];
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      return y - x;
    }
    return a.n - b.n;
  });
  return [...keyed.map((x) => x.i), ...items.filter((i) => i.done)];
}
