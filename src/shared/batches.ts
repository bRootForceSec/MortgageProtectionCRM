// Finding batches once there are hundreds of them. The Import page, the batch picker on Leads and
// Reports' "By batch" all filter and group batches the same way, with these.

/** One batch as the batch lists show it. */
export interface BatchListRow {
  id: string;
  name: string;
  file_name: string | null;
  imported_at: string;
  /** What you paid for the batch, or the sum of its leads' prices when that wasn't entered. */
  cost_cents: number | null;
  rows_total: number;
  rows_accepted: number;
  rows_rejected: number;
  rows_repeat: number;
  lead_types: string[];
  left: number;
  /** The bulk import it came from, if any. */
  bulk_id: string | null;
}

/** A line in the batch lists: one batch, or a bulk import with its files' batches. */
export interface ImportGroup {
  kind: 'batch' | 'bulk';
  /** The batch id, or the bulk import's id. */
  id: string;
  imported_at: string;
  batches: BatchListRow[];
  /** Only when a filter left some of a bulk import's batches out. */
  batches_total: number;
  totals: { leads: number; rejected: number; repeats: number; cost_cents: number | null; left: number; lead_types: string[] };
  /** For a bulk import: its files, and how many are still being read or wait for you. */
  bulk?: { files: number; reading: number; to_check: number };
}

/** What you can narrow a batch list by. Every field is optional; an empty filter matches everything. */
export interface BatchFilter {
  /** Part of the batch's name, file name, or a lead type code. */
  search?: string;
  /** Only batches imported in the last this many days. */
  days?: number;
  /** Only batches with at least one lead of this type ('' = leads with no type). */
  lead_type?: string;
  /** Only batches that still have leads to call (never called, no answer or a callback). */
  left?: boolean;
}

/** What a batch has to say about itself to be filtered. */
export interface BatchFacts {
  name: string;
  file_name?: string | null;
  imported_at: string | null;
  /** Lead type codes of its leads ('' for leads with no type). */
  lead_types: string[];
  /** Leads still to call. */
  left: number;
}

export function batchMatches(b: BatchFacts, f: BatchFilter, now = Date.now()): boolean {
  const q = f.search?.trim().toLowerCase();
  if (q) {
    const hay = [b.name, b.file_name ?? '', ...b.lead_types].join(' ').toLowerCase();
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  if (f.days && (!b.imported_at || Date.parse(b.imported_at) < now - f.days * 86_400_000)) return false;
  if (f.lead_type !== undefined && !b.lead_types.includes(f.lead_type)) return false;
  if (f.left && b.left <= 0) return false;
  return true;
}

/**
 * Puts the files of each bulk import together, in the order the rows came (so sort first).
 * A batch from a single-file import is a group of its own, with bulk_id null.
 */
export function groupByImport<T extends { bulk_id: string | null }>(rows: T[]): { bulk_id: string | null; rows: T[] }[] {
  const out: { bulk_id: string | null; rows: T[] }[] = [];
  const bulk = new Map<string, { bulk_id: string | null; rows: T[] }>();
  for (const r of rows) {
    if (!r.bulk_id) {
      out.push({ bulk_id: null, rows: [r] });
      continue;
    }
    const g = bulk.get(r.bulk_id);
    if (g) g.rows.push(r);
    else {
      const n = { bulk_id: r.bulk_id, rows: [r] };
      bulk.set(r.bulk_id, n);
      out.push(n);
    }
  }
  return out;
}
