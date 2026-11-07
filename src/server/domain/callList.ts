import type { DB } from '../db/connection.js';
import { LEAD_NAME, CURRENT_OUTCOME } from '../db/sql.js';
import { APPT_RESULTS, type ApptResult } from '../../shared/appointments.js';
import { AGE_BANDS, type AgeBand } from '../../shared/leadAge.js';
import { isLastCall, lastCallRange, type ApptDays, type ImportedWhen, type LeadQuery } from '../../shared/leadFilter.js';
import { nowIso, uuidv7 } from '../ids.js';
import { groupWhere, parseList, searchWhere } from './groupFilter.js';
import { DomainError } from '../core/errors.js';
import { loadCallingSettings } from './callingSettings.js';
import { conditionSql, sortStepSql } from './formulas.js';
import type { SortStep } from '../../shared/listOrder.js';
import { statusWhere } from './statuses.js';
import { FormulaError } from '../../shared/formula.js';
import { logNeverDialOverride, neverDialOf } from './tags.js';
import { callableIds } from './callable.js';

// The call list: the leads you chose to call, worked top to bottom. Leads get here only when you add them
// (from Leads, or with an import); nothing is added, removed or moved on its own.
// A lead counts as worked once a call (not undone) was saved for it after it was added, so undoing
// a call puts it back to "to call" without any extra bookkeeping.

export interface LeadFilter {
  status?: string;
  search?: string;
  batch_id?: string;
  /** Leads from every file of one bulk import. */
  bulk_id?: string;
  counties?: string[];
  areaCodes?: string[];
  /** Only leads last tried before this time (and never-called leads are left out). */
  tried_before?: string;
  /** Only leads last tried at or after this time, e.g. the start of today. */
  tried_after?: string;
  /** Only leads that aren't waiting on the call list (worked ones count as off it). */
  not_on_list?: boolean;
  /** Only leads of this lead type code, or '' for leads with none. */
  lead_type?: string;
  /** Only leads whose call-in date is this many days back (see shared/leadAge.ts), or 'unknown' for none. */
  age?: AgeBand | 'unknown';
  /** Only leads from files imported on these days (any number of batches). */
  imported?: ImportedWhen;
  /** Only leads with an appointment on these days (from Unitrust, or an appointment call logged here). */
  appt_days?: ApptDays;
  /** Leave out leads dialed in the last this many minutes. */
  not_within_min?: number;
  /** Only leads with this tag (its id), or '' for leads with no tags. */
  tag?: string;
  /** Only leads with a value in this custom field: any value, `value` (any case), or a number from min to max. */
  custom?: { field_id: string; value?: string; min?: number; max?: number };
  /** Highest value in this number, money or formula field first (Leads, and adding to the call list). */
  sort_field?: string;
  /** Only leads with an appointment this many days ago. */
  appt_days_ago?: number;
  /** Only leads waiting on the call list. */
  on_list?: boolean;
  /** Only these leads (a rule run for the leads a change happened to). */
  only_leads?: string[];
  /** Only leads this condition (Python syntax, a yes/no formula) is true for. */
  where?: string;
  /** Only leads in this status of yours (its id). */
  in_status?: string;
}

/** The Leads filters as the API (or a routine step) gives them, with relative choices worked out now. */
export function toLeadFilter(q: LeadQuery, now = new Date()): LeadFilter {
  const last = q.last_call && isLastCall(q.last_call) ? lastCallRange(q.last_call, now) : null;
  return {
    status: q.status,
    search: q.search,
    batch_id: q.batch_id || undefined,
    bulk_id: q.bulk_id || undefined,
    counties: parseList(q.counties),
    areaCodes: parseList(q.area_codes),
    tried_before: last ? last.before : q.tried_before || undefined,
    tried_after: last ? last.after : q.tried_after || undefined,
    not_on_list: q.not_on_list === true || q.not_on_list === '1' || q.not_on_list === 'true',
    lead_type: !q.lead_type ? undefined : q.lead_type === 'none' ? '' : q.lead_type,
    age: (q.age || undefined) as LeadFilter['age'],
    imported: (q.imported || undefined) as ImportedWhen | undefined,
    appt_days: (q.appt_days || undefined) as ApptDays | undefined,
    not_within_min: q.not_within_min || undefined,
    tag: !q.tag ? undefined : q.tag === 'none' ? '' : q.tag,
    custom: q.field_id ? { field_id: q.field_id, value: q.field_value || undefined, min: q.field_min ?? undefined, max: q.field_max ?? undefined } : undefined,
    sort_field: q.sort_field || undefined,
    appt_days_ago: q.appt_days_ago ?? undefined,
    on_list: q.on_list === true || q.on_list === '1' || q.on_list === 'true',
    where: q.where?.trim() || undefined,
    in_status: q.in_status || undefined,
  };
}

/** Today on this computer, as an SQL date expression. */
const TODAY = "date('now', 'localtime')";

/**
 * The first and last day (YYYY-MM-DD, as SQL expressions) of an appointment-day choice. "Since my last calling day"
 * runs from the last day before today with a call through yesterday, so on a Monday it takes in the weekend.
 */
export function apptDaysSql(key: ApptDays): { from: string; to: string } {
  const yesterday = `date(${TODAY}, '-1 day')`;
  if (key === 'yesterday') return { from: yesterday, to: yesterday };
  const lastCallDay = `(SELECT max(date(c.requested_at, 'localtime')) FROM call c
    WHERE c.voided_at IS NULL AND c.initiation_result = 'accepted' AND date(c.requested_at, 'localtime') < ${TODAY})`;
  return { from: `coalesce(${lastCallDay}, ${yesterday})`, to: yesterday };
}

/** The appointment-day choice as actual days, YYYY-MM-DD. */
export function apptDayRange(db: DB, key: ApptDays): { from: string; to: string } {
  const d = apptDaysSql(key);
  return db.prepare(`SELECT ${d.from} "from", ${d.to} "to"`).get() as { from: string; to: string };
}

function importedWhere(when: ImportedWhen | undefined): string {
  if (!when) return '1';
  const day = "date(ib.imported_at, 'localtime')";
  const cond = when === 'today' ? `${day} = ${TODAY}` : when === 'yesterday' ? `${day} = date(${TODAY}, '-1 day')` : `${day} >= date(${TODAY}, '-6 days')`;
  return `l.batch_id IN (SELECT ib.id FROM import_batch ib WHERE ${cond})`;
}

/** Leads with an appointment on those days: one in Unitrust (not moved away), or an appointment call logged here. */
function apptDaysWhere(key: ApptDays | undefined): string {
  if (!key) return '1';
  const d = apptDaysSql(key);
  return apptOnDays(d.from, d.to);
}

/** Leads with an appointment between two days (SQL date expressions). */
function apptOnDays(from: string, to: string): string {
  const d = { from, to };
  return `l.id IN (
    SELECT a.lead_id FROM appointment a WHERE a.recorded_via = 'unitrust' AND a.internal_status = 'scheduled'
      AND substr(a.scheduled_for, 1, 10) BETWEEN ${d.from} AND ${d.to}
    UNION
    SELECT c.lead_id FROM call c JOIN call_outcome o ON o.call_id = c.id AND ${CURRENT_OUTCOME} JOIN outcome_code oc ON oc.code = o.outcome_code
      WHERE c.voided_at IS NULL AND oc.kind = 'appointment' AND date(c.requested_at, 'localtime') BETWEEN ${d.from} AND ${d.to})`;
}

/** Leads with an appointment exactly this many days ago (in this computer's days). */
function apptDaysAgoWhere(n: number | undefined): string {
  if (n == null) return '1';
  const day = `date(${TODAY}, '-${Math.trunc(n)} days')`;
  return apptOnDays(day, day);
}

/** Leads page tabs for how the latest appointment went (lead_state.appt_result). */
const APPT_TABS: Record<string, ApptResult> = Object.fromEntries(
  (Object.entries(APPT_RESULTS) as [ApptResult, (typeof APPT_RESULTS)[ApptResult]][]).flatMap(([r, d]) => (d.tab ? [[d.tab.key, r]] : [])),
);

/** Leads in one lead age band, by whole days since their call-in date. */
function ageWhere(age: LeadFilter['age']): string {
  if (!age) return '1';
  if (age === 'unknown') return 'l.callin_at IS NULL';
  const b = AGE_BANDS.find((x) => x.key === age)!;
  const days = "CAST(julianday('now') - julianday(l.callin_at) AS INTEGER)";
  return `(l.callin_at IS NOT NULL AND ${days} >= ${b.min}${b.max == null ? '' : ` AND ${days} <= ${b.max}`})`;
}

/** A condition as SQL, or a DomainError saying what's wrong with it. */
function whereSql(db: DB, src: string): string {
  try {
    return conditionSql(db, src);
  } catch (e) {
    if (e instanceof FormulaError) throw new DomainError(`The condition: ${e.message}`);
    throw e;
  }
}

/** SQL condition over `lead l JOIN lead_state s` for the Leads page filters. */
export function leadFilterWhere(db: DB, f: LeadFilter): { sql: string; params: Record<string, unknown> } {
  const group = groupWhere('l.county_key', { counties: f.counties, areaCodes: f.areaCodes });
  const search = searchWhere(f.search);
  // "Tried" leads split by how the last call went: not reached (no answer) or talked with no appointment.
  // Leads a no-show or yellow in Unitrust put back to be called have their own tab ("appt_missed"), not these two.
  const tried = f.status === 'no_answer' || f.status === 'talked' ? f.status : null;
  const missed = f.status === 'appt_missed';
  // How the lead's latest appointment went, whatever its status now: each result is its own tab.
  const appt = f.status && Object.hasOwn(APPT_TABS, f.status) ? APPT_TABS[f.status]! : null;
  const status = tried || missed ? 'retry' : appt ? null : f.status && f.status !== 'all' ? f.status : null;
  const talked = "coalesce((SELECT grp FROM outcome_code WHERE code = s.last_outcome_code), '') = 'contact'";
  const parts = [
    '(@lf_status IS NULL OR s.status = @lf_status)',
    tried === 'talked' ? `${talked} AND s.appt_missed = 0` : tried === 'no_answer' ? `NOT ${talked} AND s.appt_missed = 0` : missed ? 's.appt_missed = 1' : '1',
    appt ? 's.appt_result = @lf_appt' : '1',
    '(@lf_batch IS NULL OR l.batch_id = @lf_batch)',
    "(@lf_type IS NULL OR coalesce(l.lead_type, '') = @lf_type)",
    f.bulk_id
      ? `l.batch_id IN (SELECT b.value FROM import_bulk_file f, json_each(f.summary_json, '$.batches') b WHERE f.bulk_id = @lf_bulk AND f.summary_json IS NOT NULL)`
      : '1',
    '(@lf_before IS NULL OR (s.last_call_at IS NOT NULL AND s.last_call_at < @lf_before))',
    '(@lf_after IS NULL OR (s.last_call_at IS NOT NULL AND s.last_call_at >= @lf_after))',
    ageWhere(f.age),
    importedWhere(f.imported),
    apptDaysWhere(f.appt_days),
    apptDaysAgoWhere(f.appt_days_ago),
    f.only_leads ? 'l.id IN (SELECT value FROM json_each(@lf_only))' : '1',
    f.on_list ? `l.id IN (SELECT i.lead_id FROM call_list_item i WHERE NOT ${WORKED})` : '1',
    f.not_within_min ? '(s.last_call_at IS NULL OR s.last_call_at < @lf_gap)' : '1',
    f.tag === undefined ? '1' : f.tag === '' ? 'l.id NOT IN (SELECT lead_id FROM lead_tag)' : 'l.id IN (SELECT lead_id FROM lead_tag WHERE tag_id = @lf_tag)',
    f.custom
      ? `l.id IN (SELECT v.lead_id FROM lead_field_value v WHERE v.field_id = @lf_field${f.custom.value ? ' AND lower(v.value) = lower(@lf_fval)' : ''}${
          f.custom.min != null ? ' AND CAST(v.value AS REAL) >= @lf_fmin' : ''}${f.custom.max != null ? ' AND CAST(v.value AS REAL) <= @lf_fmax' : ''})`
      : '1',
    f.not_on_list ? `l.id NOT IN (SELECT i.lead_id FROM call_list_item i WHERE NOT ${WORKED})` : '1',
    f.where ? whereSql(db, f.where) : '1',
    f.in_status ? statusWhere(db, f.in_status) : '1',
    group.sql,
    search.sql,
  ];
  return {
    sql: parts.join(' AND '),
    params: { lf_status: status, ...(appt ? { lf_appt: appt } : {}), lf_batch: f.batch_id ?? null, lf_type: f.lead_type ?? null, ...(f.bulk_id ? { lf_bulk: f.bulk_id } : {}), lf_before: f.tried_before ?? null, lf_after: f.tried_after ?? null, ...(f.tag ? { lf_tag: f.tag } : {}), ...(f.only_leads ? { lf_only: JSON.stringify(f.only_leads) } : {}), ...(f.custom ? { lf_field: f.custom.field_id, ...(f.custom.value ? { lf_fval: f.custom.value } : {}), ...(f.custom.min != null ? { lf_fmin: f.custom.min } : {}), ...(f.custom.max != null ? { lf_fmax: f.custom.max } : {}) } : {}), ...(f.not_within_min ? { lf_gap: new Date(Date.now() - f.not_within_min * 60_000).toISOString() } : {}), ...group.params, ...search.params },
  };
}

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
  done: { label: string; dials: number; call_id: string; at: string } | null;
  /** A callback with a time set (the time it's due), so you can see it on the list. */
  callback_due_at: string | null;
  /** When you marked that this lead called you back. */
  called_back_at: string | null;
  /** How the lead's latest appointment went (lead_state.appt_result). */
  appt_result: string | null;
  /** When the lead called in (UTC), for its age. */
  callin_at: string | null;
  /** The lead's time zone, for "Best time first". */
  time_zone: string | null;
  /** What each of your sort steps gives this lead (`list_order`; null for best time, or no value), for "Your order". */
  sort_keys: (number | null)[];
}

/** A sort step's SQL; one with a mistake (a field it names has gone) sorts nothing. */
function sortKey(db: DB, step: SortStep): string {
  if (step.by !== 'formula') return 'NULL';
  try {
    return sortStepSql(db, step.formula);
  } catch (e) {
    if (e instanceof FormulaError) return 'NULL';
    throw e;
  }
}

export function getCallList(db: DB): CallListItem[] {
  const steps = loadCallingSettings(db).list_order;
  const keys = steps.map((st, n) => `, ${sortKey(db, st)} sk${n}`).join('');
  const rows = db
    .prepare(
      `SELECT i.lead_id, i.added_at, ${LEAD_NAME} name,
              coalesce(s.active_phone_e164, l.phone_e164) phone_e164, l.state, l.county, l.callin_at, l.time_zone, s.status, s.attempts_total, s.last_call_at, s.appt_result,
              CASE WHEN s.status = 'callback' THEN s.next_due_at END callback_due_at, cb.at called_back_at${keys},
              w.id call_id, w.requested_at worked_at, w.dial_count,
              (SELECT oc.label FROM call_outcome o JOIN outcome_code oc ON oc.code = o.outcome_code
                WHERE o.call_id = w.id AND ${CURRENT_OUTCOME}
                ORDER BY o.entered_at DESC LIMIT 1) label
       FROM call_list_item i
       JOIN lead l ON l.id = i.lead_id
       JOIN lead_state s ON s.lead_id = l.id
       LEFT JOIN lead_called_back cb ON cb.lead_id = l.id
       LEFT JOIN call w ON w.id = (
         SELECT c.id FROM call c WHERE c.lead_id = i.lead_id AND c.voided_at IS NULL AND c.requested_at >= i.added_at
         ORDER BY c.requested_at DESC LIMIT 1)
       ORDER BY i.position`,
    )
    .all() as any[];
  return rows.map((r) => ({
    lead_id: r.lead_id,
    name: r.name || '(no name)',
    phone_e164: r.phone_e164,
    state: r.state,
    county: r.county,
    status: r.status,
    attempts_total: r.attempts_total,
    last_call_at: r.last_call_at,
    added_at: r.added_at,
    callback_due_at: r.callback_due_at,
    called_back_at: r.called_back_at ?? null,
    appt_result: r.appt_result ?? null,
    callin_at: r.callin_at ?? null,
    time_zone: r.time_zone ?? null,
    sort_keys: steps.map((_, n) => (r[`sk${n}`] == null ? null : Number(r[`sk${n}`]))),
    done: r.call_id ? { label: r.label ?? 'Called', dials: r.dial_count ?? 1, call_id: r.call_id, at: r.worked_at } : null,
  }));
}

export interface AddResult {
  added: number;
  already: number;
  /** Leads that can't be called: dead, no good number, or not allowed by your "Can be called when". */
  not_callable: number;
  /** Left off because of a never-dial tag (Settings → Tags), with why; `override` adds them anyway. */
  skipped: { lead_id: string; name: string; why: string }[];
}

/**
 * Adds leads to the bottom of the list, in the order given. Leads an appointment put back go to the top instead, so the
 * rebook call comes first (Settings can turn that off). After that the list is yours: S still moves them down.
 */
export function addToCallList(db: DB, leadIds: string[], now = nowIso(), opts: { override?: boolean } = {}): AddResult {
  const res: AddResult = { added: 0, already: 0, not_callable: 0, skipped: [] };
  const never = neverDialOf(db, [...new Set(leadIds)]);
  const callable = callableIds(db, [...new Set(leadIds)]);
  const name = db.prepare(`SELECT ${LEAD_NAME} name FROM lead l WHERE l.id = ?`);
  const missedFirst = loadCallingSettings(db).missed_appts_first;
  const status = db.prepare('SELECT status, appt_missed FROM lead_state WHERE lead_id = ?');
  const has = db.prepare(`SELECT ${WORKED} worked FROM call_list_item i WHERE i.lead_id = ?`);
  const ins = db.prepare('INSERT INTO call_list_item (lead_id, position, added_at) VALUES (?, ?, ?)');
  const again = db.prepare('UPDATE call_list_item SET position = ?, added_at = ? WHERE lead_id = ?');
  db.transaction(() => {
    let pos = bottom(db);
    const toAdd: { id: string; on: boolean; top: boolean }[] = [];
    for (const id of new Set(leadIds)) {
      const s = status.get(id) as { status: string; appt_missed: number } | undefined;
      if (!s) continue;
      const on = has.get(id) as { worked: number } | undefined;
      if (on && !on.worked) res.already++;
      else if (!callable.has(id)) res.not_callable++;
      else if (never.has(id) && !opts.override) {
        res.skipped.push({ lead_id: id, name: (name.get(id) as { name: string | null }).name ?? 'A lead', why: `tagged ${never.get(id)!.tag}` });
      } else {
        if (never.has(id)) logNeverDialOverride(db, id, never.get(id)!.tag, 'added anyway', now);
        toAdd.push({ id, on: !!on, top: missedFirst && s.appt_missed === 1 });
      }
    }
    // The ones going to the top keep the order given, above everything already there.
    const tops = toAdd.filter((a) => a.top);
    let topPos = top(db) - tops.length;
    for (const a of toAdd) {
      const p = a.top ? topPos++ : ++pos;
      // Already called from this list: it goes back as "to call".
      if (a.on) again.run(p, now, a.id);
      else ins.run(a.id, p, now);
      res.added++;
    }
  })();
  return res;
}

/** ORDER BY terms for a sort field (highest first, no value last), before the usual order; '' without one. */
export function sortFieldOrder(f: LeadFilter): { sql: string; params: Record<string, unknown> } {
  if (!f.sort_field) return { sql: '', params: {} };
  return { sql: '(SELECT CAST(sv.value AS REAL) FROM lead_field_value sv WHERE sv.lead_id = l.id AND sv.field_id = @lf_sort) DESC NULLS LAST, ', params: { lf_sort: f.sort_field } };
}

/** Every lead matching the Leads page filters, in import order (newest batch last, file order), or by its sort field. */
export function matchingLeadIds(db: DB, f: LeadFilter): string[] {
  const w = leadFilterWhere(db, f);
  const o = sortFieldOrder(f);
  return db
    .prepare(
      `SELECT l.id FROM lead l JOIN lead_state s ON s.lead_id = l.id JOIN import_batch b ON b.id = l.batch_id
       JOIN import_row r ON r.id = l.import_row_id
       WHERE ${w.sql} ORDER BY ${o.sql}b.imported_at, r.row_number`,
    )
    .all({ ...w.params, ...o.params })
    .map((r: any) => r.id as string);
}

export function addMatchingToCallList(db: DB, f: LeadFilter, now = nowIso()): AddResult {
  return addToCallList(db, matchingLeadIds(db, f), now);
}

/** Adds a batch's leads (just imported) in file order. */
export function addBatchToCallList(db: DB, batchId: string, now = nowIso()): AddResult {
  const ids = db
    .prepare('SELECT l.id FROM lead l JOIN import_row r ON r.id = l.import_row_id WHERE l.batch_id = ? ORDER BY r.row_number')
    .all(batchId)
    .map((r: any) => r.id as string);
  return addToCallList(db, ids, now);
}

export function removeFromCallList(db: DB, leadId: string): boolean {
  return db.prepare('DELETE FROM call_list_item WHERE lead_id = ?').run(leadId).changes > 0;
}

/** Takes the worked leads off the list. Returns how many went. */
export function clearWorked(db: DB): number {
  const worked = getCallList(db).filter((i) => i.done).map((i) => i.lead_id);
  const del = db.prepare('DELETE FROM call_list_item WHERE lead_id = ?');
  db.transaction(() => worked.forEach((id) => del.run(id)))();
  return worked.length;
}

/** Skip: the lead goes to the bottom of the list, where you can still see it. */
export function moveToBottom(db: DB, leadId: string): boolean {
  return db.prepare('UPDATE call_list_item SET position = ? WHERE lead_id = ?').run(bottom(db) + 1, leadId).changes > 0;
}

/** The leads waiting to be called on the call list (ones already called from it can be added again). */
export function onCallList(db: DB, leadIds: string[]): Set<string> {
  if (!leadIds.length) return new Set();
  const rows = db
    .prepare(`SELECT i.lead_id FROM call_list_item i WHERE i.lead_id IN (SELECT value FROM json_each(?)) AND NOT ${WORKED}`)
    .all(JSON.stringify(leadIds));
  return new Set(rows.map((r: any) => r.lead_id as string));
}

/** The last outcomes you set (newest first), to catch a wrong one even after the list was cleared. */
export function recentOutcomes(db: DB, limit = 10) {
  return db
    .prepare(
      `SELECT c.id call_id, c.lead_id, c.requested_at, o.entered_at, oc.label,
              ${LEAD_NAME} name
       FROM call c JOIN lead l ON l.id = c.lead_id
       JOIN call_outcome o ON o.call_id = c.id AND ${CURRENT_OUTCOME}
       JOIN outcome_code oc ON oc.code = o.outcome_code
       WHERE c.voided_at IS NULL AND c.channel = 'manual_log' AND coalesce(c.history_source, '') <> 'sheet'
       ORDER BY o.entered_at DESC LIMIT ?`,
    )
    .all(limit) as { call_id: string; lead_id: string; requested_at: string; entered_at: string; label: string; name: string }[];
}

function bottom(db: DB): number {
  return (db.prepare('SELECT coalesce(max(position), 0) p FROM call_list_item').get() as { p: number }).p;
}
function top(db: DB): number {
  return (db.prepare('SELECT coalesce(min(position), 1) p FROM call_list_item').get() as { p: number }).p;
}

// ---------- saved lists ----------
// A saved list is a copy of a call list you can come back to (say, one area code while you call another).
// Save writes the call list over the saved list it came from; Save as makes a new one (or writes over the
// one with that name). Load makes a copy of a saved list the call list; the saved list stays where it is.
// Each lead keeps the time it was added, so leads you already worked still show as worked when it comes back.

export interface SavedList {
  id: string;
  name: string;
  saved_at: string;
  total: number;
  /** Leads with no call since they were added. */
  to_call: number;
}

/** Which saved list the call list is, if any, and whether it changed since it was saved or loaded. */
export interface CallListMeta {
  /** The list's name: the saved list it is, or the name it had when loaded before saved lists were kept. */
  name: string | null;
  saved_list_id: string | null;
  /** True when the call list has leads that its saved list doesn't match (or it was never saved). */
  unsaved: boolean;
}

/** The name of the list being called, if it came from a saved list or was named. */
export function callListName(db: DB): string | null {
  return callListMeta(db).name;
}

export function callListMeta(db: DB): CallListMeta {
  const m = db.prepare('SELECT name, saved_list_id FROM call_list_meta WHERE id = 1').get() as
    | { name: string | null; saved_list_id: string | null }
    | undefined;
  const listId = m?.saved_list_id ?? null;
  return { name: m?.name ?? null, saved_list_id: listId, unsaved: differsFromSaved(db, listId) };
}

/** Whether the call list differs from saved list `listId` (same leads, order and added times). Empty never counts. */
function differsFromSaved(db: DB, listId: string | null): boolean {
  const n = (db.prepare('SELECT COUNT(*) n FROM call_list_item').get() as { n: number }).n;
  if (n === 0) return false;
  if (!listId) return true;
  const diff = db
    .prepare(
      `SELECT EXISTS (SELECT lead_id, position, added_at FROM call_list_item
                      EXCEPT SELECT lead_id, position, added_at FROM saved_call_list_item WHERE list_id = @id)
           OR EXISTS (SELECT lead_id, position, added_at FROM saved_call_list_item WHERE list_id = @id
                      EXCEPT SELECT lead_id, position, added_at FROM call_list_item) d`,
    )
    .get({ id: listId }) as { d: number };
  return diff.d === 1;
}

function setCallListMeta(db: DB, name: string | null, savedListId: string | null) {
  db.prepare(
    'INSERT INTO call_list_meta (id, name, saved_list_id) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, saved_list_id = excluded.saved_list_id',
  ).run(name, savedListId);
}

/** In a query over `call_list_item i`: the lead was called (and not undone) since it went on the list. */
export const WORKED = `EXISTS (SELECT 1 FROM call c WHERE c.lead_id = i.lead_id AND c.voided_at IS NULL AND c.requested_at >= i.added_at)`;

export function listSavedLists(db: DB): SavedList[] {
  return db
    .prepare(
      `SELECT sl.id, sl.name, sl.saved_at, COUNT(i.lead_id) total, coalesce(SUM(CASE WHEN i.lead_id IS NOT NULL AND NOT ${WORKED} THEN 1 ELSE 0 END), 0) to_call
       FROM saved_call_list sl LEFT JOIN saved_call_list_item i ON i.list_id = sl.id
       GROUP BY sl.id ORDER BY sl.saved_at DESC`,
    )
    .all() as SavedList[];
}

/** Writes the call list into saved list `listId` (made if missing) under `name`, and makes it the list's saved list. */
function writeSaved(db: DB, listId: string, name: string, now: string): SavedList {
  db.prepare('INSERT INTO saved_call_list (id, name, saved_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, saved_at = excluded.saved_at').run(listId, name, now);
  db.prepare('DELETE FROM saved_call_list_item WHERE list_id = ?').run(listId);
  db.prepare('INSERT INTO saved_call_list_item (list_id, lead_id, position, added_at) SELECT ?, lead_id, position, added_at FROM call_list_item').run(listId);
  setCallListMeta(db, name, listId);
  return listSavedLists(db).find((l) => l.id === listId)!;
}

/**
 * Save as: keeps the call list as a saved list named `name`. A saved list with that name (any case) is
 * written over; otherwise a new one is made. Returns null for an empty list or a blank name.
 */
export function saveCallListAs(db: DB, name: string, now = nowIso()): SavedList | null {
  const n = name.trim();
  return db.transaction(() => {
    if (!n || !(db.prepare('SELECT 1 FROM call_list_item LIMIT 1').get())) return null;
    const same = db.prepare('SELECT id FROM saved_call_list WHERE name = ? COLLATE NOCASE ORDER BY saved_at DESC LIMIT 1').get(n) as { id: string } | undefined;
    return writeSaved(db, same?.id ?? uuidv7(), n, now);
  })();
}

/** Save: writes the call list over the saved list it is. Throws when it isn't one yet (use Save as). */
export function saveCallList(db: DB, now = nowIso()): SavedList {
  return db.transaction(() => {
    const m = db.prepare('SELECT sl.id, sl.name FROM call_list_meta m JOIN saved_call_list sl ON sl.id = m.saved_list_id WHERE m.id = 1').get() as
      | { id: string; name: string }
      | undefined;
    if (!m) throw new DomainError('this call list has no name yet: use Save as', 409);
    if (!(db.prepare('SELECT 1 FROM call_list_item LIMIT 1').get())) throw new DomainError('the call list is empty', 409);
    return writeSaved(db, m.id, m.name, now);
  })();
}

/**
 * Empties the call list. With a name, the leads on it are first kept as a saved list (returned),
 * as Save as does. Their calls and outcomes are never touched.
 */
export function clearCallList(db: DB, saveAs?: string | null, now = nowIso()): { removed: number; saved: SavedList | null } {
  return db.transaction(() => {
    const n = (db.prepare('SELECT COUNT(*) n FROM call_list_item').get() as { n: number }).n;
    const saved = saveAs ? saveCallListAs(db, saveAs, now) : null;
    db.prepare('DELETE FROM call_list_item').run();
    setCallListMeta(db, null, null);
    return { removed: n, saved };
  })();
}

/**
 * Load: the call list becomes a copy of a saved list, which stays saved. The current list is cleared first
 * (kept under `saveCurrentAs` if given).
 */
export function loadSavedList(db: DB, listId: string, saveCurrentAs?: string | null, now = nowIso()): { loaded: number; saved: SavedList | null } | null {
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM saved_call_list WHERE id = ?').get(listId)) return null;
    const { saved } = clearCallList(db, saveCurrentAs, now);
    // Saving the current list under this list's name writes over it, so read the name afterwards.
    const list = db.prepare('SELECT name FROM saved_call_list WHERE id = ?').get(listId) as { name: string };
    const loaded = db
      .prepare('INSERT INTO call_list_item (lead_id, position, added_at) SELECT lead_id, position, added_at FROM saved_call_list_item WHERE list_id = ?')
      .run(listId).changes;
    setCallListMeta(db, list.name, listId);
    return { loaded, saved };
  })();
}

/** Deletes a saved list. The call list keeps its leads (and its name) but is no longer saved anywhere. */
export function deleteSavedList(db: DB, listId: string): boolean {
  return db.prepare('DELETE FROM saved_call_list WHERE id = ?').run(listId).changes > 0;
}

/** "They called me back": sets or clears the mark on a lead. Returns the time set, or null when cleared. */
export function setCalledBack(db: DB, leadId: string, on: boolean, now = nowIso()): string | null {
  if (!db.prepare('SELECT 1 FROM lead WHERE id = ?').get(leadId)) throw new DomainError('lead not found', 404);
  if (!on) {
    db.prepare('DELETE FROM lead_called_back WHERE lead_id = ?').run(leadId);
    return null;
  }
  db.prepare('INSERT INTO lead_called_back (lead_id, at) VALUES (?, ?) ON CONFLICT(lead_id) DO NOTHING').run(leadId, now);
  return (db.prepare('SELECT at FROM lead_called_back WHERE lead_id = ?').get(leadId) as { at: string }).at;
}

/** Callbacks due before `to`, including ones missed earlier and ones with no time yet. For the agenda. */
export function callbacksDue(db: DB, to: string, groups: { counties?: string[]; areaCodes?: string[] }) {
  const group = groupWhere('l.county_key', groups);
  const name = LEAD_NAME;
  return db
    .prepare(
      `SELECT l.id lead_id, ${name} name, l.phone_e164, l.time_zone, l.county, l.state, s.next_due_at due_at, s.due_any_time = 1 any_time
       FROM lead_state s JOIN lead l ON l.id = s.lead_id
       WHERE s.status = 'callback' AND (s.next_due_at IS NULL OR s.next_due_at < @to) AND ${group.sql}
       ORDER BY s.next_due_at IS NULL, s.next_due_at`,
    )
    .all({ to, ...group.params });
}
