// Thin client for the local API. All requests are same-origin; the access cookie is sent automatically.

export class ApiError extends Error {
  constructor(message: string, public status: number, public problems: string[] = []) {
    super(message);
  }
}

async function handle<T>(r: Response): Promise<T> {
  if (r.ok) return (await r.json()) as T;
  let msg = `Request failed (${r.status})`;
  let problems: string[] = [];
  try {
    const j = await r.json();
    msg = j.error ?? msg;
    problems = j.problems ?? [];
  } catch {
    /* not JSON */
  }
  throw new ApiError(msg, r.status, problems);
}

export const api = {
  get: <T>(path: string, params?: Record<string, string | undefined>) => {
    const q = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][]) : null;
    return fetch(`/api${path}${q && q.toString() ? `?${q}` : ''}`, { credentials: 'same-origin' }).then((r) => handle<T>(r));
  },
  post: <T>(path: string, body: unknown) =>
    fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  upload: <T>(path: string, file: File, contentType = 'application/octet-stream') =>
    fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': contentType, 'x-file-name': encodeURIComponent(file.name), 'x-file-modified': String(file.lastModified || '') },
      body: file,
    }).then((r) => handle<T>(r)),
  put: <T>(path: string, body: unknown) =>
    fetch(`/api${path}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  patch: <T>(path: string, body: unknown) =>
    fetch(`/api${path}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  del: <T>(path: string) => fetch(`/api${path}`, { method: 'DELETE', credentials: 'same-origin' }).then((r) => handle<T>(r)),
};

export function newKey(): string {
  return crypto.randomUUID();
}

// ---------- shared types (mirror the API) ----------
export interface OutcomeCode {
  code: string;
  label: string;
  grp: string;
  hotkey: string | null;
  requires_callback_time: number;
  marks_dead: number;
  counts_as_human_contact: number;
}

export interface CallerNumber {
  id: string;
  e164: string;
  label: string | null;
  status: 'pending' | 'active' | 'standby' | 'retired';
  reputation_status: 'unchecked' | 'clear' | 'flagged' | 'investigating';
  reputation_updated_at: string | null;
  acquired_at: string | null;
  retired_at: string | null;
  retire_reason: string | null;
  notes: string | null;
}

export interface Meta {
  outcome_codes: OutcomeCode[];
  lead_fields: { key: string; label: string }[];
  numbers: CallerNumber[];
  data_dir: string;
  version: { commit: string; built_at: string | null };
}

export interface QueueItem {
  lead_id: string;
  bucket: 'callback_due' | 'appointment_passed' | 'new' | 'retry';
  name: string;
  phone_e164: string | null;
  state: string | null;
  time_zone: string | null;
  batch_name: string;
  attempts_total: number;
  last_call_at: string | null;
  last_outcome_code: string | null;
  next_due_at: string | null;
  skipped_today: boolean;
  county: string | null;
  county_key: string | null;
  needs_time: boolean;
}

export interface QueueResponse {
  items: QueueItem[];
  counts: Record<QueueItem['bucket'], number>;
  total: number;
  waiting_later: number;
}

export interface Outcome {
  id: string;
  call_id: string;
  outcome_code: string;
  label: string;
  entered_at: string;
  superseded: number;
  callback_due_at: string | null;
  note: string | null;
}

export interface Call {
  id: string;
  channel: string;
  from_e164: string | null;
  from_label: string | null;
  to_e164: string;
  requested_at: string;
  state: string;
  talk_seconds: number | null;
  /** 0 for history from a spreadsheet's Status column: the real time isn't known. */
  time_known: number;
  history_source: string | null;
  /** Dials made for this one attempt. */
  dial_count: number;
  /** Set when you undid this call. */
  voided_at: string | null;
  outcomes: Outcome[];
  current_outcome: Outcome | null;
  events: { id: string; source: string; event_type: string; occurred_at: string; received_at: string }[];
}

export interface LeadDetail {
  lead: Record<string, any> & { id: string; extra: Record<string, string> };
  state: { status: string; attempts_total: number; last_call_at: string | null; last_outcome_code: string | null; next_due_at: string | null; preferred_number_id: string | null } | null;
  batch: { id: string; name: string; imported_at: string; cost_per_lead_cents: number | null; lead_type: string | null; lead_age_label: string | null; file_name: string | null };
  import_row: { row_number: number; warnings_json: string | null } | null;
  calls: Call[];
  notes: { id: string; body: string; created_at: string; call_id: string | null }[];
  actions: { id: string; action: string; reason: string | null; created_at: string }[];
  appointments: { id: string; scheduled_for: string | null; recorded_via: string; from_e164: string | null; from_label: string | null; internal_status: string; official_status: string | null; result: string | null; notes: string | null }[];
  linked: { link_id: string; link_status: string; reason: string; id: string; first_name: string | null; last_name: string | null; batch_name: string; status: string }[];
  changes: { id: string; field: string; old_value: string | null; new_value: string | null; created_at: string }[];
  lead_type: { code: string; label: string; price_cents: number | null } | null;
  county_area_codes: string[];
}

// ---------- formatting ----------
export function fmtPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function fmtDateTime(iso: string | null | undefined, tz?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  const a = Math.abs(d);
  const s = a < 60 ? 'just now' : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  if (s === 'just now') return s;
  return d >= 0 ? `${s} ago` : `in ${s}`;
}

export function localTime(tz: string | null | undefined): string {
  if (!tz) return '';
  try {
    return new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
  } catch {
    return '';
  }
}

export function fmtMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 });
}

export function fullName(l: { first_name?: string | null; last_name?: string | null; [k: string]: unknown }): string {
  return [l.first_name, l.last_name].filter(Boolean).join(' ') || '(no name)';
}

/** Value for <input type="datetime-local"> from a Date, in the browser's zone. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
