/**
 * Appointments are almost always set for the same day: today at the next half hour.
 * After the evening cutoff it suggests tomorrow at 10 AM instead.
 */
export function defaultWhen(cutoffHour: number, now = new Date()): Date {
  const t = new Date(now);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() < 30 ? 30 : 60);
  if (now.getHours() >= cutoffHour || t.getDate() !== now.getDate()) {
    const m = new Date(now);
    m.setDate(m.getDate() + 1);
    m.setHours(10, 0, 0, 0);
    return m;
  }
  return t;
}
