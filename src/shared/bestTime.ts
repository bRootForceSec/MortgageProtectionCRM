// "Best time first" on the call list: the leads it's the best time to call right now come first, by the pickup rate
// you've had at that weekday and hour in the lead's own time (the Best time to call report). Where you have too few
// calls at that hour, a usual curve stands in (evenings best). Leads where it's before 8 AM or from 9 PM go last.

/** Attempts and pickups by the lead's local "weekday:hour" (weekday 0 = Sunday). */
export type BestTimes = Record<string, { attempts: number; pickups: number }>;

/** Fewer attempts than this at an hour, and the usual curve is used instead. */
export const MIN_ATTEMPTS = 10;

/** A usual pickup curve by local hour, for hours without enough of your own calls. */
function usual(hour: number): number {
  if (hour >= 17 && hour < 20) return 0.3;
  if (hour >= 9 && hour < 17) return 0.2;
  return 0.1;
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

/** How good a time it is to call a lead now: its pickup rate, or -1 outside 8 AM to 9 PM where the lead is. */
export function bestTimeScore(times: BestTimes, tz: string | null | undefined, now = new Date()): number {
  const { weekday, hour } = localNow(tz, now);
  if (hour < 8 || hour >= 21) return -1;
  const t = times[`${weekday}:${hour}`];
  return t && t.attempts >= MIN_ATTEMPTS ? t.pickups / t.attempts : usual(hour);
}

/** The list in "Best time first" order: leads still to call by score (ties keep their order), then the worked ones. */
export function bestTimeFirst<T extends { done: unknown; time_zone: string | null }>(items: T[], times: BestTimes, now = new Date()): T[] {
  const scored = items.filter((i) => !i.done).map((i, n) => ({ i, n, s: bestTimeScore(times, i.time_zone, now) }));
  scored.sort((a, b) => b.s - a.s || a.n - b.n);
  return [...scored.map((x) => x.i), ...items.filter((i) => i.done)];
}
