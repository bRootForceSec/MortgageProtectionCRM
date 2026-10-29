// Lead age: days since the lead called in (the call-in date on the lead page), in the bands the Leads filter,
// the call list and Reports use.

export const AGE_BANDS = [
  { key: '0_7', label: '0–7 days', min: 0, max: 7 },
  { key: '8_30', label: '8–30 days', min: 8, max: 30 },
  { key: '31_90', label: '31–90 days', min: 31, max: 90 },
  { key: 'older', label: 'Older than 90 days', min: 91, max: null },
] as const;
export type AgeBand = (typeof AGE_BANDS)[number]['key'];

/** Whole days from the call-in time to `at`; null without a call-in date. */
export function leadAgeDays(callinAt: string | null | undefined, at: Date | string = new Date()): number | null {
  if (!callinAt) return null;
  const t = Date.parse(callinAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((new Date(at).getTime() - t) / 86_400_000));
}

/** The band a lead age falls in; null when the age isn't known. */
export function ageBand(days: number | null): AgeBand | null {
  if (days == null) return null;
  return AGE_BANDS.find((b) => days >= b.min && (b.max == null || days <= b.max))!.key;
}

export function isAgeBand(v: string | null | undefined): v is AgeBand {
  return AGE_BANDS.some((b) => b.key === v);
}
