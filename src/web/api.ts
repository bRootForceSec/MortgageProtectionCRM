import type { StatusBadge } from '../shared/statuses';
import type { CustomFieldType } from '../shared/customFields';
import { ageOn } from '../shared/age';
import { leadAgeDays } from '../shared/leadAge';
import type { OtherPhone } from '../shared/phones';
import type { CallMode } from '../shared/appointments';
import type { BestTimes } from '../shared/bestTime';
import type { ButtonInfo } from '../shared/buttons';

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
  upload: <T>(path: string, file: File, contentType = 'application/octet-stream', headers: Record<string, string> = {}) =>
    fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': contentType, 'x-file-name': encodeURIComponent(file.name), 'x-file-modified': String(file.lastModified || ''), ...headers },
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
  /** Which side of the Calling screen it belongs to. */
  kind: CallMode;
  /** Has a button on the Calling screen (Settings → Outcomes). */
  offered: boolean;
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
  /** Your Calling screen buttons, in order (Settings → Buttons). */
  buttons: ButtonInfo[];
  /** Why a lead said no: offered as chips after an outcome that asks for them. */
  objection_codes: { code: string; label: string }[];
  lead_fields: { key: string; label: string }[];
  numbers: CallerNumber[];
  data_dir: string;
  version: { commit: string; built_at: string | null };
  /** Products the Unitrust extension found that still need their comp rules. */
  products_need_rules: number;
}

// Mirrors src/server/domain/policies.ts.
export interface Product {
  id: string;
  carrier: string;
  name: string;
  kind: 'term' | 'final_expense' | 'other' | null;
  comp_hit_points: number | null;
  advance_pct: number | null;
  policies: number;
  needs_rules: boolean;
}
export interface CompLevel {
  id: string;
  level: number;
  effective_from: string;
  source: 'unitrust' | 'manual';
  created_at: string;
}
export interface PolicyView {
  id: string;
  unitrust_app_id: string;
  policy_number: string | null;
  lead_id: string | null;
  lead_name: string | null;
  lead_linked_by: 'auto' | 'manual' | null;
  client_name: string | null;
  carrier: string;
  product: string;
  product_id: string;
  kind: Product['kind'];
  status: string | null;
  stage: 'paid' | 'pending' | 'out';
  premium_cents: number | null;
  ap_cents: number | null;
  applied_on: string | null;
  paid_on: string | null;
  lapsed_on: string | null;
  level: number | null;
  comp_hit_points: number | null;
  advance_pct: number | null;
  commission_cents: number | null;
}

/** A lead on the call list (Calling page). */
export interface CallListItem {
  lead_id: string;
  name: string;
  phone_e164: string | null;
  state: string | null;
  county: string | null;
  status: string;
  attempts_total: number;
  last_call_at: string | null;
  added_at: string;
  /** Set once the lead was worked: the outcome you gave it and how many dials. */
  done: { label: string; dials: number; call_id?: string; at?: string } | null;
  callback_due_at: string | null;
  called_back_at: string | null;
  /** How the lead's latest appointment went (no show, sat, prezi, sold...). */
  appt_result: string | null;
  callin_at: string | null;
  time_zone: string | null;
}

export interface RecentOutcome {
  call_id: string;
  lead_id: string;
  entered_at: string;
  label: string;
  name: string;
}

/** A call list put away to call later. */
export interface SavedList {
  id: string;
  name: string;
  saved_at: string;
  total: number;
  to_call: number;
}

export interface CallListResponse {
  items: CallListItem[];
  recent: RecentOutcome[];
  /** The list's name, when it was saved or loaded from a saved list. */
  name: string | null;
  /** The saved list this call list is (Save writes over it), or null when it isn't saved. */
  saved_list_id: string | null;
  /** The call list has leads its saved list doesn't match, or was never saved. */
  unsaved: boolean;
  saved_lists: SavedList[];
  /** Pickups by the lead's local weekday and hour, for "Best time first". */
  best_times: BestTimes;
}

export interface AddResult {
  added: number;
  already: number;
  not_callable: number;
}

export interface Outcome {
  id: string;
  call_id: string;
  outcome_code: string;
  label: string;
  entered_at: string;
  superseded: number;
  callback_due_at: string | null;
  /** 1 when the callback is for a day, any time that day. */
  callback_any_time?: number;
  /** 1 when you ticked "Do not call". */
  do_not_call?: number;
  note: string | null;
  /** The button it was saved with, and its name then (null: the outcome's own button, or from before buttons). */
  button_id?: string | null;
  button_label?: string | null;
}

/** What a call's outcome reads as: the button it was saved with when that wasn't the outcome's own. */
export function outcomeText(o: Pick<Outcome, 'label' | 'outcome_code' | 'button_id' | 'button_label'>): string {
  return o.button_label && o.button_id !== o.outcome_code ? `${o.button_label} (${o.label})` : o.label;
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
  /** Seconds the lead was on the Calling screen before this call was saved. */
  lead_seconds: number | null;
  /** Set when you undid this call. */
  voided_at: string | null;
  outcomes: Outcome[];
  current_outcome: Outcome | null;
  events: { id: string; source: string; event_type: string; occurred_at: string; received_at: string }[];
}

export interface TagRef { id: string; name: string }
/** A tag and how many leads have it (Settings → Tags, and the pickers). */
export interface Tag extends TagRef { leads: number }

export interface LeadDetail {
  lead: Record<string, any> & { id: string; extra: Record<string, string>;
    /** Numbers besides the main one, in order. */
    other_phones: OtherPhone[];
  };
  state: { status: string; attempts_total: number; last_call_at: string | null; last_outcome_code: string | null; next_due_at: string | null; preferred_number_id: string | null;
    /** The number to call now: the first of the lead's numbers that isn't ruled out. */
    active_phone_e164: string | null;
    /** The lead's numbers that are ruled out (JSON list). */
    blocked_phones_json: string | null;
    block_reason: string | null;
    /** How the latest appointment went: logged on the Appointment side, or read from Unitrust by the extension. */
    appt_result: string | null;
    /** 1 when a no-show, sat-no-sale or prezi put the lead back to be called. */
    appt_missed: number;
  } | null;
  batch: { id: string; name: string; imported_at: string; cost_per_lead_cents: number | null; lead_type: string | null; lead_age_label: string | null; file_name: string | null };
  import_row: { row_number: number; warnings_json: string | null; raw_json: string | null } | null;
  /** The PDF this lead came from is on this computer: its page can be shown (source_page on the lead). */
  source_pdf: boolean;
  /** The lead's appointment as it stands: typed on Appt set, or from Unitrust, which wins once it sends one. */
  appointment: { scheduled_for: string; source: 'app' | 'unitrust' } | null;
  /** When you marked that this lead called you back (null if not). */
  called_back_at: string | null;
  /** Your tags on this lead, by name. */
  tags: TagRef[];
  /** Your statuses this lead is in, in your order. */
  statuses: StatusBadge[];
  /** Calling screen buttons whose show-when condition is false for this lead now. */
  hidden_buttons: string[];
  /** Every custom field, in order, with this lead's value (null for none). */
  custom: {
    field_id: string; label: string; type: CustomFieldType; options: string[]; value: string | null;
    /** Its show-when condition is true for this lead now (Settings → Your fields), and its needed-when one. */
    shown: boolean; required: boolean;
  }[];
  calls: Call[];
  notes: { id: string; body: string; created_at: string; call_id: string | null }[];
  actions: { id: string; action: string; reason: string | null; created_at: string }[];
  linked: { link_id: string; link_status: string; reason: string; id: string; first_name: string | null; last_name: string | null; batch_name: string; status: string }[];
  changes: { id: string; field: string; old_value: string | null; new_value: string | null; created_at: string }[];
  /** The lead's log, newest first: tags put on and taken off, and what did it. */
  events: { id: string; at: string; kind: string; tag_name: string | null; source: string; source_name: string | null }[];
  lead_type: { code: string; label: string; price_cents: number | null } | null;
  county_area_codes: string[];
}

// ---------- formatting ----------
/** The lead's age today: from the date of birth when there is one, else the age as imported. */
export function personAge(l: { dob?: string | null; age?: number | null } & Record<string, unknown>, at = new Date()): number | null {
  if (l.dob && /^\d{4}-\d{2}-\d{2}$/.test(l.dob)) {
    return ageOn(l.dob, at);
  }
  return l.age ?? null;
}

/** "Mar 14, 1961" from YYYY-MM-DD, without a time zone shift. */
export function fmtDob(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

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

/** A short length of time: "45s", "3m 20s", "1h 5m". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)}m` : ''}`;
}

export function localTime(tz: string | null | undefined): string {
  if (!tz) return '';
  try {
    return new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
  } catch {
    return '';
  }
}

/** "12d old" from the call-in date; '' without one. */
export function fmtLeadAge(callinAt: string | null | undefined): string {
  const d = leadAgeDays(callinAt);
  return d == null ? '' : `${d}d old`;
}

export function fmtMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 });
}

export function fullName(l: { first_name?: string | null; last_name?: string | null; [k: string]: unknown }): string {
  return [l.first_name, l.last_name].filter(Boolean).join(' ') || '(no name)';
}

/** Appointments still blue in Unitrust on some days (GET /appointments/unmarked). Mirrors ApptRow on the server, in part. */
export interface UnmarkedAppts {
  from: string;
  to: string;
  appointments: { id: string; lead_id: string; lead_name: string; day: string; time: string | null }[];
}
