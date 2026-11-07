import * as z from 'zod/v4';
import { LEAD_FILTERS, LEAD_TABS } from './leadStatus.js';
import { AGE_BANDS, isAgeBand } from './leadAge.js';

// Relative day choices for the Leads filters (and the rules built on them). They're kept as keys, not
// dates, so a saved rule means the same thing every day; the server works out the days in the computer's time.

export const IMPORTED_WHEN = [
  { key: 'today', label: 'Imported today' },
  { key: 'yesterday', label: 'Imported yesterday' },
  { key: 'week', label: 'Imported in the past 7 days' },
] as const;
export type ImportedWhen = (typeof IMPORTED_WHEN)[number]['key'];

export const APPT_DAYS = [
  { key: 'yesterday', label: 'Appointment yesterday', title: 'Leads with an appointment yesterday' },
  {
    key: 'since_last_calling_day',
    label: 'Appointment since my last calling day',
    title: 'Leads with an appointment from the last day you made calls through yesterday. On a Monday after a weekend off, that is Friday to Sunday.',
  },
] as const;
export type ApptDays = (typeof APPT_DAYS)[number]['key'];

/** "Not dialed in the last N minutes" choices. */
export const DIAL_GAPS = [15, 30, 60, 120, 240] as const;

export function isImportedWhen(v: unknown): v is ImportedWhen {
  return IMPORTED_WHEN.some((x) => x.key === v);
}

export function isApptDays(v: unknown): v is ApptDays {
  return APPT_DAYS.some((x) => x.key === v);
}

export function gapLabel(min: number): string {
  return min < 60 ? `${min} min` : `${min / 60} hour${min === 60 ? '' : 's'}`;
}

/** When the last call was: a recent window, or long enough ago to try again. Never-called leads match none of them. */
export const LAST_CALL = [
  { key: 'today', label: 'Last call today' },
  { key: 'not_today', label: 'Called before, not today' },
  { key: 'yesterday', label: 'Last call yesterday' },
  { key: 'week', label: 'Last call in the past 7 days' },
  { key: '4h', label: 'Last call 4+ hours ago' },
  { key: '1d', label: 'Last call 1+ day ago' },
  { key: '3d', label: 'Last call 3+ days ago' },
  { key: '7d', label: 'Last call 1+ week ago' },
] as const;
export type LastCall = (typeof LAST_CALL)[number]['key'];

export function isLastCall(v: unknown): v is LastCall {
  return LAST_CALL.some((x) => x.key === v);
}

/** The times a last-call choice stands for, in this computer's time. */
export function lastCallRange(key: LastCall, now = new Date()): { after?: string; before?: string } {
  const day = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).toISOString();
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const H = 3_600_000;
  switch (key) {
    case 'today': return { after: day(0) };
    case 'not_today': return { before: day(0) };
    case 'yesterday': return { after: day(1), before: day(0) };
    case 'week': return { after: day(6) };
    case '4h': return { before: ago(4 * H) };
    case '1d': return { before: ago(24 * H) };
    case '3d': return { before: ago(72 * H) };
    case '7d': return { before: ago(168 * H) };
  }
}

/**
 * The Leads filters as the API takes them (query strings), and as a rule keeps them. Everything relative
 * (last call, imported, appointment day) is a key, worked out when it's used.
 */
export const LeadQuery = z.object({
  status: z.enum(LEAD_FILTERS).default('all'),
  search: z.string().max(100).optional(),
  batch_id: z.string().max(64).optional(),
  bulk_id: z.string().max(64).optional(),
  counties: z.string().max(4000).optional(),
  area_codes: z.string().max(400).optional(),
  tried_before: z.string().max(40).optional(),
  tried_after: z.string().max(40).optional(),
  /** A last-call choice, worked out now. Used instead of tried_before and tried_after. */
  last_call: z.string().refine((v) => !v || isLastCall(v), 'unknown last call choice').optional(),
  not_on_list: z.union([z.boolean(), z.enum(['1', '0', 'true', 'false'])]).optional(),
  /** A lead type code, or "none" for leads with no type. */
  lead_type: z.string().max(20).optional(),
  /** A lead age band (leadAge.ts), or "unknown" for leads with no call-in date. */
  age: z.string().refine((v) => !v || v === 'unknown' || isAgeBand(v), 'unknown lead age').optional(),
  imported: z.string().refine((v) => !v || isImportedWhen(v), 'unknown import day').optional(),
  appt_days: z.string().refine((v) => !v || isApptDays(v), 'unknown appointment day').optional(),
  not_within_min: z.coerce.number().int().min(0).max(10_080).optional(),
  /** A tag id, or "none" for leads with no tags. */
  tag: z.string().max(64).optional(),
  /** A custom field id: only leads with a value in it, or with field_value, with that value (any case). */
  field_id: z.string().max(64).optional(),
  field_value: z.string().max(200).optional(),
  /** With field_id, for a number, money or formula field: only values in this range (either end may be left open). */
  field_min: z.coerce.number().optional(),
  field_max: z.coerce.number().optional(),
  /** A number, money or formula field to put leads in order by, highest first (leads with no value last). */
  sort_field: z.string().max(64).optional(),
  /** Only leads with an appointment this many days ago (1 is yesterday). */
  appt_days_ago: z.coerce.number().int().min(0).max(60).optional(),
  /** Only leads waiting on the call list (called ones count as off it). The opposite of not_on_list. */
  on_list: z.union([z.boolean(), z.enum(['1', '0', 'true', 'false'])]).optional(),
  /** A condition in Python syntax (a yes/no formula), like `has("No show") and attempts >= 3`: only leads it's true for. */
  where: z.string().max(2000).optional(),
  /** One of your statuses (its id): only leads in it. */
  in_status: z.string().max(64).optional(),
});
export type LeadQuery = z.infer<typeof LeadQuery>;

/** How many leads a page of the Leads list shows: your choice of these. */
export const LEAD_PAGE_SIZES = [25, 50, 100, 250, 500] as const;

/** Which page of the Leads list (from 1) and how many on a page. */
export const LeadPaging = z.object({
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  per_page: z.coerce.number().int().refine((n) => (LEAD_PAGE_SIZES as readonly number[]).includes(n), 'unknown page size').optional(),
});

/**
 * The filter in words, e.g. "No answer · Last call today · Not dialed in the last 1 hour". `names` turns tag, custom
 * field and smart list ids into their names (a deleted one says so).
 */
export function describeFilter(f: Partial<LeadQuery>, names: { tag?: (id: string) => string | undefined; field?: (id: string) => string | undefined; status?: (id: string) => string | undefined } = {}): string {
  const label = <T extends { key: string; label: string }>(list: readonly T[], key: string | undefined) => (key ? list.find((x) => x.key === key)?.label ?? key : null);
  const lists = (v: string | undefined, one: string, many: string) => {
    const n = v ? v.split(',').filter(Boolean).length : 0;
    return n ? `${n} ${n === 1 ? one : many}` : null;
  };
  return [
    f.status && f.status !== 'all' ? label(LEAD_TABS, f.status) ?? (f.status === 'appt_missed' ? 'Missed appointments' : f.status) : 'All leads',
    label(IMPORTED_WHEN, f.imported),
    label(APPT_DAYS, f.appt_days),
    f.appt_days_ago != null ? (f.appt_days_ago === 1 ? 'Appointment yesterday' : f.appt_days_ago === 0 ? 'Appointment today' : `Appointment ${f.appt_days_ago} days ago`) : null,
    label(LAST_CALL, f.last_call),
    f.not_within_min ? `Not dialed in the last ${gapLabel(f.not_within_min)}` : null,
    f.lead_type ? (f.lead_type === 'none' ? 'No lead type' : `Lead type ${f.lead_type}`) : null,
    f.age ? (f.age === 'unknown' ? 'No call-in date' : `Age ${label(AGE_BANDS, f.age)}`) : null,
    f.tag ? (f.tag === 'none' ? 'No tags' : `Tagged "${names.tag?.(f.tag) ?? 'a deleted tag'}"`) : null,
    f.field_id ? `${names.field?.(f.field_id) ?? 'A deleted field'} ${fieldTest(f)}` : null,
    f.batch_id || f.bulk_id ? 'One import' : null,
    lists(f.counties, 'county', 'counties'),
    lists(f.area_codes, 'area code', 'area codes'),
    f.search ? `Search "${f.search}"` : null,
    f.not_on_list === '1' || f.not_on_list === true ? 'Not on the call list' : null,
    f.on_list === '1' || f.on_list === true ? 'Waiting on the call list' : null,
    f.sort_field ? `Highest ${names.field?.(f.sort_field) ?? 'deleted field'} first` : null,
    f.in_status ? `In smart list "${names.status?.(f.in_status) ?? 'a deleted smart list'}"` : null,
    f.where ? `Where ${f.where.length > 80 ? `${f.where.slice(0, 77)}…` : f.where}` : null,
  ].filter(Boolean).join(' · ');
}

/** "is "Warm"", "50 or more", "from 10 to 20", or "filled in". */
function fieldTest(f: Partial<LeadQuery>): string {
  if (f.field_value) return `is "${f.field_value}"`;
  if (f.field_min != null && f.field_max != null) return `from ${f.field_min} to ${f.field_max}`;
  if (f.field_min != null) return `${f.field_min} or more`;
  if (f.field_max != null) return `${f.field_max} or less`;
  return 'filled in';
}
