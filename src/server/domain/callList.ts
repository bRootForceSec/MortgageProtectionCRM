import type { DB } from '../db/connection.js';
import { LEAD_NAME, CURRENT_OUTCOME } from '../db/sql.js';
import { APPT_RESULTS, type ApptResult } from '../../shared/appointments.js';
import { isCallable } from '../../shared/leadStatus.js';
import { nowIso, uuidv7 } from '../ids.js';
import { groupWhere, searchWhere } from './groupFilter.js';
import { DomainError } from '../core/errors.js';

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
}

/** Leads page tabs for how the latest appointment went (lead_state.appt_result). */
const APPT_TABS: Record<string, ApptResult> = Object.fromEntries(
  (Object.entries(APPT_RESULTS) as [ApptResult, (typeof APPT_RESULTS)[ApptResult]][]).flatMap(([r, d]) => (d.tab ? [[d.tab.key, r]] : [])),
);

/** SQL condition over `lead l JOIN lead_state s` for the Leads page filters. */
export function leadFilterWhere(f: LeadFilter): { sql: string; params: Record<string, unknown> } {
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
    f.not_on_list ? `l.id NOT IN (SELECT i.lead_id FROM call_list_item i WHERE NOT ${WORKED})` : '1',
    group.sql,
    search.sql,
  ];
  return {
    sql: parts.join(' AND '),
    params: { lf_status: status, ...(appt ? { lf_appt: appt } : {}), lf_batch: f.batch_id ?? null, lf_type: f.lead_type ?? null, ...(f.bulk_id ? { lf_bulk: f.bulk_id } : {}), lf_before: f.tried_before ?? null, lf_after: f.tried_after ?? null, ...group.params, ...search.params },
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
  /** The lead's time zone, for "Best time first". */
  time_zone: string | null;
}

export function getCallList(db: DB): CallListItem[] {
  const rows = db
    .prepare(
      `SELECT i.lead_id, i.added_at, ${LEAD_NAME} name,
              coalesce(s.active_phone_e164, l.phone_e164) phone_e164, l.state, l.county, l.time_zone, s.status, s.attempts_total, s.last_call_at, s.appt_result,
              CASE WHEN s.status = 'callback' THEN s.next_due_at END callback_due_at, cb.at called_back_at,
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
    time_zone: r.time_zone ?? null,
    done: r.call_id ? { label: r.label ?? 'Called', dials: r.dial_count ?? 1, call_id: r.call_id, at: r.worked_at } : null,
  }));
}

export interface AddResult {
  added: number;
  already: number;
  /** Booked, bad-number or dead leads, which can't be called. */
  not_callable: number;
}

/** Adds leads to the bottom of the list, in the order given. */
export function addToCallList(db: DB, leadIds: string[], now = nowIso()): AddResult {
  const res: AddResult = { added: 0, already: 0, not_callable: 0 };
  const status = db.prepare('SELECT status FROM lead_state WHERE lead_id = ?');
  const has = db.prepare(`SELECT ${WORKED} worked FROM call_list_item i WHERE i.lead_id = ?`);
  const ins = db.prepare('INSERT INTO call_list_item (lead_id, position, added_at) VALUES (?, ?, ?)');
  const again = db.prepare('UPDATE call_list_item SET position = ?, added_at = ? WHERE lead_id = ?');
  db.transaction(() => {
    let pos = bottom(db);
    for (const id of new Set(leadIds)) {
      const s = status.get(id) as { status: string } | undefined;
      if (!s) continue;
      const on = has.get(id) as { worked: number } | undefined;
      if (on && !on.worked) res.already++;
      else if (!isCallable(s.status)) res.not_callable++;
      else {
        // Already called from this list: it goes back to the bottom as "to call".
        if (on) again.run(++pos, now, id);
        else ins.run(id, ++pos, now);
        res.added++;
      }
    }
  })();
  return res;
}

/** Adds every lead matching the Leads page filters, in import order (newest batch last, file order). */
/** Every lead matching the Leads page filters, in import order. */
export function matchingLeadIds(db: DB, f: LeadFilter): string[] {
  const w = leadFilterWhere(f);
  return db
    .prepare(
      `SELECT l.id FROM lead l JOIN lead_state s ON s.lead_id = l.id JOIN import_batch b ON b.id = l.batch_id
       JOIN import_row r ON r.id = l.import_row_id
       WHERE ${w.sql} ORDER BY b.imported_at, r.row_number`,
    )
    .all(w.params)
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

// ---------- saved lists ----------
// A saved list is a call list put away to come back to later (say, one area code while you call another).
// Loading it makes it the call list again and takes it off the saved lists, so there is only ever one copy.
// Each lead keeps the time it was added, so leads you already worked still show as worked when it comes back.

export interface SavedList {
  id: string;
  name: string;
  saved_at: string;
  total: number;
  /** Leads with no call since they were added. */
  to_call: number;
}

/** The name of the list being called, if it came from a saved list or was named. */
export function callListName(db: DB): string | null {
  return (db.prepare('SELECT name FROM call_list_meta WHERE id = 1').get() as { name: string | null } | undefined)?.name ?? null;
}

function setCallListName(db: DB, name: string | null) {
  db.prepare('INSERT INTO call_list_meta (id, name) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name').run(name);
}

const WORKED = `EXISTS (SELECT 1 FROM call c WHERE c.lead_id = i.lead_id AND c.voided_at IS NULL AND c.requested_at >= i.added_at)`;

export function listSavedLists(db: DB): SavedList[] {
  return db
    .prepare(
      `SELECT sl.id, sl.name, sl.saved_at, COUNT(i.lead_id) total, coalesce(SUM(CASE WHEN i.lead_id IS NOT NULL AND NOT ${WORKED} THEN 1 ELSE 0 END), 0) to_call
       FROM saved_call_list sl LEFT JOIN saved_call_list_item i ON i.list_id = sl.id
       GROUP BY sl.id ORDER BY sl.saved_at DESC`,
    )
    .all() as SavedList[];
}

/**
 * Empties the call list. With a name, the leads on it are first kept as a saved list (returned).
 * Their calls and outcomes are never touched.
 */
export function clearCallList(db: DB, saveAs?: string | null, now = nowIso()): { removed: number; saved: SavedList | null } {
  return db.transaction(() => {
    const n = (db.prepare('SELECT COUNT(*) n FROM call_list_item').get() as { n: number }).n;
    let saved: SavedList | null = null;
    const name = saveAs?.trim();
    if (name && n > 0) {
      const id = uuidv7();
      db.prepare('INSERT INTO saved_call_list (id, name, saved_at) VALUES (?, ?, ?)').run(id, name, now);
      db.prepare('INSERT INTO saved_call_list_item (list_id, lead_id, position, added_at) SELECT ?, lead_id, position, added_at FROM call_list_item').run(id);
      saved = listSavedLists(db).find((l) => l.id === id) ?? null;
    }
    db.prepare('DELETE FROM call_list_item').run();
    setCallListName(db, null);
    return { removed: n, saved };
  })();
}

/** Makes a saved list the call list again (the current one is cleared first, kept under `saveCurrentAs` if given). */
export function loadSavedList(db: DB, listId: string, saveCurrentAs?: string | null, now = nowIso()): { loaded: number; saved: SavedList | null } | null {
  return db.transaction(() => {
    const list = db.prepare('SELECT name FROM saved_call_list WHERE id = ?').get(listId) as { name: string } | undefined;
    if (!list) return null;
    const { saved } = clearCallList(db, saveCurrentAs, now);
    const loaded = db
      .prepare('INSERT INTO call_list_item (lead_id, position, added_at) SELECT lead_id, position, added_at FROM saved_call_list_item WHERE list_id = ?')
      .run(listId).changes;
    db.prepare('DELETE FROM saved_call_list WHERE id = ?').run(listId);
    setCallListName(db, list.name);
    return { loaded, saved };
  })();
}

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
