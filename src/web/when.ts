// The callback picker (key 5): a day, and an optional time. Typed, so it works without the mouse.
//   Day:  t / today, m / tomorrow, a weekday ("fri"), or a date ("10/24", "10/24/27", "2026-10-24").
//   Time: blank for "any time that day", or "2", "2:30", "230p", "10am", "14:30".
//         A time with no AM/PM from 1 to 7 is taken as PM (calling hours).
//   The time is the lead's own time when you pass their time zone: "call me at 2" means 2 where they are.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Local midnight at the start of `d`'s day. */
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** The same time of day, `n` calendar days later (or earlier, for negative `n`). */
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** The 24 hours from `start`, as the from/to the API takes. */
export function dayRange(start: Date): { from: string; to: string } {
  return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
}

/** Today, from your local midnight. */
export function todayRange(): { from: string; to: string } {
  return dayRange(startOfDay(new Date()));
}

/** YYYY-MM-DD in your time zone, as a date input wants it. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The day you typed, at local midnight, or null if it isn't a day. */
export function parseDay(text: string, now = new Date()): Date | null {
  const t = text.trim().toLowerCase().replace(/\.$/, '');
  if (!t) return null;
  const today = startOfDay(now);
  if (['t', 'today', 'tod', 'tdy'].includes(t)) return today;
  if (['m', 'tomorrow', 'tom', 'tmr', 'tmrw', 'tomo'].includes(t)) return addDays(today, 1);
  if (t.length >= 2 && /^[a-z]+$/.test(t)) {
    const wd = WEEKDAYS.findIndex((w) => w.startsWith(t));
    if (wd >= 0) {
      // The next one after today ("fri" on a Friday means next Friday).
      const ahead = ((wd - today.getDay() + 7) % 7) || 7;
      return addDays(today, ahead);
    }
    return null;
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return makeDate(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(t);
  if (m) {
    const month = +m[1]!, day = +m[2]!;
    if (m[3]) return makeDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], month, day);
    // No year: this year, or next year if that day has passed.
    const d = makeDate(today.getFullYear(), month, day);
    return d && d < today ? makeDate(today.getFullYear() + 1, month, day) : d;
  }
  return null;
}

function makeDate(y: number, mo: number, d: number): Date | null {
  const x = new Date(y, mo - 1, d);
  return x.getFullYear() === y && x.getMonth() === mo - 1 && x.getDate() === d ? x : null;
}

/** Minutes after midnight; null for blank (any time); NaN if it isn't a time. */
export function parseTime(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  if (!t) return null;
  if (t === 'noon') return 12 * 60;
  const m = /^(\d{1,2})(?::?(\d{2}))?(a|p|am|pm)?$/.exec(t);
  if (!m) return NaN;
  let h = +m[1]!;
  const min = m[2] ? +m[2] : 0;
  if (min > 59) return NaN;
  const ap = m[3]?.[0];
  if (ap) {
    if (h < 1 || h > 12) return NaN;
    if (ap === 'p' && h !== 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
  } else {
    if (h > 23) return NaN;
    if (h >= 1 && h <= 7) h += 12;
  }
  return h * 60 + min;
}

export interface CallbackWhen {
  /** When the callback is due: the time you gave, or the start of the day for "any time". */
  at: Date;
  anyTime: boolean;
}

/** Year, month, day, hour and minute of a moment as a clock in that time zone shows it. */
function wallClock(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute') };
}

/** The moment when a clock in `tz` shows that date and time. */
export function fromWallClock(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  // Two passes settle the zone's offset, including on daylight-saving days.
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(t), tz);
    t += want - Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  }
  return new Date(t);
}

function validZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True when the lead's clock shows a different time from yours right now. */
export function differentZone(tz: string | null | undefined, at = new Date()): boolean {
  if (!validZone(tz)) return false;
  const w = wallClock(at, tz);
  return w.h !== at.getHours() || w.mi !== at.getMinutes();
}

/**
 * Reads the two picker fields. Returns an error message instead when something can't be read.
 * With the lead's time zone, the time you type is their time.
 */
export function readCallback(dayText: string, timeText: string, now = new Date(), tz?: string | null): CallbackWhen | { error: string } {
  const day = parseDay(dayText, now);
  if (!day) return { error: 'Type a day: t for today, m for tomorrow, a weekday, or a date like 10/24' };
  const mins = parseTime(timeText);
  if (mins === null) return { at: day, anyTime: true };
  if (Number.isNaN(mins)) return { error: 'Type a time like 2, 2:30 or 10am, or leave it blank for any time' };
  let at = new Date(day);
  at.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  if (validZone(tz)) at = fromWallClock(day.getFullYear(), day.getMonth() + 1, day.getDate(), Math.floor(mins / 60), mins % 60, tz);
  if (at.getTime() < now.getTime() - 60_000) return { error: 'That time has already passed today' };
  return { at, anyTime: false };
}

/** "Tomorrow, Sat Oct 18, any time" or "Mon Oct 20 at 2:30 PM", with their time and yours when they differ. */
export function describeCallback(w: CallbackWhen, now = new Date(), tz?: string | null): string {
  const today = startOfDay(now);
  const days = Math.round((startOfDay(w.at).getTime() - today.getTime()) / 86_400_000);
  const name = days === 0 ? 'Today, ' : days === 1 ? 'Tomorrow, ' : '';
  const date = w.at.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', ...(w.at.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
  const mine = w.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (w.anyTime) return `${name}${date}, any time`;
  if (!differentZone(tz, w.at)) return `${name}${date} at ${mine}`;
  const theirs = w.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz! });
  return `${name}${date} at ${theirs} their time (${mine} yours)`;
}

/** Puts a saved callback back into the picker fields (after an undo), in the lead's time when given. */
export function callbackFields(iso: string | null, anyTime: boolean, tz?: string | null): { day: string; time: string } {
  if (!iso) return { day: '', time: '' };
  const d = new Date(iso);
  const day = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  if (anyTime) return { day, time: '' };
  const w = validZone(tz) ? wallClock(d, tz) : { h: d.getHours(), mi: d.getMinutes() };
  const time = `${w.h % 12 || 12}:${String(w.mi).padStart(2, '0')}${w.h < 12 ? 'am' : 'pm'}`;
  return { day, time };
}
