// Shapes returned by the import draft API.

export interface Issue {
  field: string;
  message: string;
  blocking: boolean;
}

export interface DraftRow {
  row_number: number;
  page: number | null;
  review: 'auto' | 'needs_review' | 'ok' | 'discarded';
  extractor: string | null;
  lead_type: string | null;
  notes: string | null;
  fields: Record<string, string>;
  read: Record<string, string>;
  edits: Record<string, string> | null;
  extra: Record<string, string>;
  raw?: Record<string, string>;
  issues: Issue[];
  status: 'accepted' | 'duplicate_in_file' | 'already_imported' | 'rejected' | null;
  status_notes: string[];
  name: string | null;
  phone: string | null;
  county: string | null;
  county_key: string | null;
  state: string | null;
}

export interface DraftSummary {
  total: number;
  accepted: number;
  rejected: number;
  discarded: number;
  duplicate_in_file: number;
  already_imported: number;
  with_warnings: number;
  possible_duplicates: number;
  in_dead_pile: number;
  file_previously_imported: { batch_id: string; name: string; imported_at: string }[];
  by_county: { county: string; county_key: string | null; count: number }[];
  by_type: { lead_type: string | null; count: number }[];
}

export interface DraftProgress {
  phase: 'text' | 'ai' | 'done';
  total: number;
  text_done: number;
  ai_total: number;
  ai_done: number;
  ai_failed: number;
  cost_usd: number;
  reader: string | null;
  error?: string | null;
}

export interface DraftView {
  id: string;
  kind: 'pdf' | 'sheet';
  file_name: string;
  file_modified: string | null;
  status: 'reading' | 'review' | 'committed';
  settings: { default_lead_type?: string | null; sheet?: string; batch?: Record<string, unknown> };
  progress: DraftProgress | null;
  summary: DraftSummary;
  needs_review: number;
  pending: number;
  rows: DraftRow[];
  reading_now: boolean;
}

export interface DraftListItem {
  id: string;
  kind: 'pdf' | 'sheet';
  file_name: string;
  status: 'reading' | 'review';
  created_at: string;
  updated_at: string;
  progress: DraftProgress | null;
  counts: Partial<Record<DraftRow['review'], number>>;
}

export interface LeadType {
  code: string;
  label: string;
  price_cents: number | null;
  sort_order: number;
  active: number;
}
