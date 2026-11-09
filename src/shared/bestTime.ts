import * as z from 'zod/v4';

// "Best time first" on the call list: the leads it's the best time to call right now come first, by the pickup rate
// you've had at that weekday and hour in the lead's own time (the Best time to call report). Where you have too few
// calls at that hour, a usual curve stands in (evenings best). Leads outside your calling hours go last. The hours and
// the number of calls are yours to set (Settings → Calling, `best_time` in calling settings).

/** Attempts and pickups by the lead's local "weekday:hour" (weekday 0 = Sunday). */
export type BestTimes = Record<string, { attempts: number; pickups: number }>;

/** Your rules for "Best time first". */
export const BestTimeRules = z.object({
  /** Fewer calls than this at an hour, and the usual curve is used instead. */
  min_calls: z.number().int().min(1).max(1000).default(10),
  /** Leads where it's before this hour, or from `to_hour` on, go last. */
  from_hour: z.number().int().min(0).max(23).default(8),
  to_hour: z.number().int().min(1).max(24).default(21),
}).refine((r) => r.from_hour < r.to_hour, 'the calling hours must start before they end');
export type BestTimeRules = z.infer<typeof BestTimeRules>;
export const STARTER_BEST_TIME: BestTimeRules = { min_calls: 10, from_hour: 8, to_hour: 21 };

/** A usual pickup curve by local hour, for hours without enough of your own calls. */
function usual(hour: number): number {
  if (hour >= 17 && hour < 20) return 0.3;
  if (hour >= 9 && hour < 17) return 0.2;
  return 0.1;
}

/** An hour of the day in words: 8 AM, noon, 9 PM, midnight. */
export const hourWords = (h: number) => (h === 0 || h === 24 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} AM` : `${h - 12} PM`);

/** All of the above in plain words, for the screens that use it. */
export function bestTimeWords(r: BestTimeRules = STARTER_BEST_TIME): string {
  return "Leads it's the best time to call right now come first, by the share of your calls that were picked up on that weekday " +
    `and hour in the lead's own time. At an hour where you have fewer than ${r.min_calls} calls, a usual curve stands in: ` +
    `5 to 8 PM best, then 9 AM to 5 PM, then other hours. Leads where it is before ${hourWords(r.from_hour)} or from ${hourWords(r.to_hour)} on go last.`;
}

const fmts = new Map<string, Intl.DateTimeFormat>();

/** The weekday (0 = Sunday) and hour it is now where the lead is; your own when the lead's zone isn't known. */
export function localNow(tz: string | null | undefined, now = new Date()): { weekday: number; hour: number } {
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let f = fmts.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    }
    fmts.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? 'Sun'), hour: Number(p.hour ?? 0) % 24 };
}

/** How good a time it is to call a lead now: its pickup rate, or -1 outside your calling hours where the lead is. */
export function bestTimeScore(times: BestTimes, tz: string | null | undefined, now = new Date(), r: BestTimeRules = STARTER_BEST_TIME): number {
  const { weekday, hour } = localNow(tz, now);
  if (hour < r.from_hour || hour >= r.to_hour) return -1;
  const t = times[`${weekday}:${hour}`];
  return t && t.attempts >= r.min_calls ? t.pickups / t.attempts : usual(hour);
}

/** The list in "Best time first" order: leads still to call by score (ties keep their order), then the worked ones. */
export function bestTimeFirst<T extends { done: unknown; time_zone: string | null }>(items: T[], times: BestTimes, now = new Date(), r: BestTimeRules = STARTER_BEST_TIME): T[] {
  const scored = items.filter((i) => !i.done).map((i, n) => ({ i, n, s: bestTimeScore(times, i.time_zone, now, r) }));
  scored.sort((a, b) => b.s - a.s || a.n - b.n);
  return [...scored.map((x) => x.i), ...items.filter((i) => i.done)];
}
