import type { DB } from '../db/connection.js';
import { nowIso } from '../ids.js';

// Queue order (documented in the UI tooltip):
//   1. callbacks that are due, oldest due first
//   2. appointments whose time has passed (follow up)
//   3. never-attempted leads, newest batch first, then file order
//   4. retries whose 4-hour gap has passed, fewest attempts first
// A lead skipped today drops to the end of its group. Dead, invalid and sold leads never appear.
// A callback or appointment from a spreadsheet has no time; it counts as due now ("needs a time" / "needs a date").
// You can limit the queue to counties, to area codes (every county linked to that code), or both.

export type QueueBucket = 'callback_due' | 'appointment_passed' | 'new' | 'retry';

export interface QueueItem {
  lead_id: string;
  bucket: QueueBucket;
  name: string;
  phone_e164: string | null;
  state: string | null;
  time_zone: string | null;
  county: string | null;
  county_key: string | null;
  batch_name: string;
  attempts_total: number;
  last_call_at: string | null;
  last_outcome_code: string | null;
  next_due_at: string | null;
  skipped_today: boolean;
  /** Callback with no time or appointment with no date. */
  needs_time: boolean;
}

export interface QueueFilter {
  counties?: string[];
  areaCodes?: string[];
}

export function getQueue(
  db: DB,
  opts: { bucket?: QueueBucket; search?: string; limit?: number; now?: string } & QueueFilter = {},
) {
  const now = opts.now ?? nowIso();
  const startOfDay = new Date(new Date(now).setHours(0, 0, 0, 0)).toISOString();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const search = opts.search?.trim().toLowerCase();
  const digits = search?.replace(/\D/g, '');
  const counties = opts.counties?.filter(Boolean) ?? [];
  const codes = opts.areaCodes?.filter((c) => /^\d{3}$/.test(c)) ?? [];
  const grouped = counties.length > 0 || codes.length > 0;

  const rows = db
    .prepare(
      `SELECT l.id lead_id, trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) name, l.phone_e164, l.state,
              l.time_zone, l.county, l.county_key, b.name batch_name, b.imported_at batch_imported_at, r.row_number,
              s.status, s.attempts_total, s.last_call_at, s.last_outcome_code, s.next_due_at, s.skipped_at
       FROM lead l JOIN lead_state s ON s.lead_id = l.id JOIN import_batch b ON b.id = l.batch_id
       JOIN import_row r ON r.id = l.import_row_id
       WHERE s.status NOT IN ('dead','invalid','sold')
         AND (@grouped = 0 OR l.county_key IN (SELECT value FROM json_each(@counties))
              OR l.county_key IN (SELECT county_key FROM county_area_code WHERE area_code IN (SELECT value FROM json_each(@codes))))
         AND (@search IS NULL OR lower(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) LIKE @like
              OR (@digits <> '' AND l.phone_e164 LIKE @dlike))`,
    )
    .all({
      search: search || null,
      like: `%${search ?? ''}%`,
      digits: digits ?? '',
      dlike: `%${digits ?? ''}%`,
      grouped: grouped ? 1 : 0,
      counties: JSON.stringify(counties),
      codes: JSON.stringify(codes),
    }) as any[];

  const items: (QueueItem & { _sort: (string | number)[] })[] = [];
  for (const r of rows) {
    let bucket: QueueBucket | null = null;
    const undated = r.next_due_at == null;
    if (r.status === 'callback' && (undated || r.next_due_at <= now)) bucket = 'callback_due';
    else if (r.status === 'appointment_set' && (undated || r.next_due_at < now)) bucket = 'appointment_passed';
    else if (r.status === 'new') bucket = 'new';
    else if (r.status === 'retry' && (undated || r.next_due_at <= now)) bucket = 'retry';
    if (!bucket || (opts.bucket && opts.bucket !== bucket)) continue;
    const skippedToday = !!r.skipped_at && r.skipped_at >= startOfDay && (!r.last_call_at || r.skipped_at > r.last_call_at);
    const order = { callback_due: 0, appointment_passed: 1, new: 2, retry: 3 }[bucket];
    const within =
      bucket === 'new'
        ? [invert(r.batch_imported_at), r.row_number]
        : bucket === 'retry'
          ? [r.attempts_total, r.last_call_at ?? '']
          : [r.next_due_at ?? ''];
    items.push({
      lead_id: r.lead_id, bucket, name: r.name || '(no name)', phone_e164: r.phone_e164, state: r.state,
      time_zone: r.time_zone, county: r.county, county_key: r.county_key, batch_name: r.batch_name, attempts_total: r.attempts_total, last_call_at: r.last_call_at,
      last_outcome_code: r.last_outcome_code, next_due_at: r.next_due_at, skipped_today: skippedToday,
      needs_time: undated && (bucket === 'callback_due' || bucket === 'appointment_passed'),
      _sort: [order, skippedToday ? 1 : 0, ...within],
    });
  }
  items.sort((a, b) => cmp(a._sort, b._sort));
  const counts = { callback_due: 0, appointment_passed: 0, new: 0, retry: 0 } as Record<QueueBucket, number>;
  for (const i of items) counts[i.bucket]++;
  const upcoming = db
    .prepare(
      `SELECT COUNT(*) n FROM lead_state WHERE (status = 'callback' AND next_due_at > @now) OR (status = 'retry' AND next_due_at > @now)`,
    )
    .get({ now }) as { n: number };
  return {
    items: items.slice(0, limit).map(({ _sort, ...i }) => i),
    counts,
    total: items.length,
    waiting_later: upcoming.n,
  };
}

function invert(iso: string): string {
  // Sort newest first using an ascending comparator.
  return String(9e15 - Date.parse(iso)).padStart(16, '0');
}

function cmp(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
