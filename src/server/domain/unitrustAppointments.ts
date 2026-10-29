import type { DB } from '../db/connection.js';
import { LEAD_NAME, CURRENT_OUTCOME } from '../db/sql.js';
import { uuidv7, nowIso } from '../ids.js';
import { getSetting, setSetting } from '../core/settings.js';
import { rebuildLeadState } from './leadState.js';
import { normalizeUsPhone } from './normalize.js';
import { outcomeDef } from '../../shared/outcomes.js';
import { APPT_RESULTS, parseUnitrustTitle, resultOfColor, type ApptResult, type UnitrustColor } from '../../shared/appointments.js';

// Appointments read off the Unitrust calendar by the Firefox extension. Each event is matched to a lead by its phone
// (then by name), stored once per day and phone, and each change of color adds a result row. Leads whose appointment
// changed get their state rebuilt, so a no-show or a sat-no-sale comes back to be called.
//
// Yellow is either "sat, no sale" or "rescheduled". Unitrust moves a rescheduled event to its new day, so a yellow
// event is a reschedule when it is on a later day than today, or when the lead's earlier appointment has gone from a
// day the calendar is showing. The appointment it replaced is marked 'rescheduled' (internal_status) and no longer counts.

export interface UnitrustEvent {
  title: string;
  /** The day the event is on, YYYY-MM-DD. */
  date: string;
  /** Start time HH:MM when the extension could tell. */
  time?: string | null;
  color: UnitrustColor;
}

export interface UnitrustSync {
  at: string;
  /** Appointment events seen (your own events are left out). */
  seen: number;
  matched: number;
  added: number;
  changed: number;
  /** Events that match no lead in the CRM, by title. */
  unmatched: string[];
}

const SETTING = 'unitrust_sync';

/** What the last sync from the extension found, for Settings. */
export function lastUnitrustSync(db: DB): UnitrustSync | null {
  return getSetting<UnitrustSync>(db, SETTING);
}

/** What the calendar was showing when it was read. */
export interface CalendarView {
  /** Today on your computer, YYYY-MM-DD. Defaults to today in UTC. */
  today?: string;
  /** The days the calendar was showing, YYYY-MM-DD. */
  days?: string[];
}

/** Stores what the extension saw on the calendar. Returns what it found. */
export function recordUnitrustEvents(db: DB, events: UnitrustEvent[], view: CalendarView = {}, now = nowIso()): UnitrustSync {
  const today = view.today ?? now.slice(0, 10);
  const shown = new Set(view.days ?? []);
  const sync: UnitrustSync = { at: now, seen: 0, matched: 0, added: 0, changed: 0, unmatched: [] };
  const touched = new Set<string>();
  const byKey = db.prepare("SELECT id, lead_id FROM appointment WHERE unitrust_key = ?");
  const current = db.prepare('SELECT result FROM appointment_result WHERE appointment_id = ? ORDER BY entered_at DESC, id DESC LIMIT 1');
  const insertAppt = db.prepare(
    `INSERT INTO appointment (id, lead_id, scheduled_for, recorded_via, created_at, unitrust_key, title)
     VALUES (@id, @lead_id, @scheduled_for, 'unitrust', @created_at, @unitrust_key, @title)`,
  );
  const updateAppt = db.prepare('UPDATE appointment SET scheduled_for = ?, title = ? WHERE id = ?');
  const insertResult = db.prepare('INSERT INTO appointment_result (id, appointment_id, result, entered_at) VALUES (?,?,?,?)');

  const earlier = db.prepare(
    `SELECT a.id, substr(a.scheduled_for, 1, 10) day, a.unitrust_key,
            (SELECT result FROM appointment_result r WHERE r.appointment_id = a.id ORDER BY entered_at DESC, id DESC LIMIT 1) result
     FROM appointment a
     WHERE a.lead_id = ? AND a.recorded_via = 'unitrust' AND a.internal_status = 'scheduled' AND a.id <> ? AND substr(a.scheduled_for, 1, 10) < ?
     ORDER BY a.scheduled_for DESC`,
  );
  const markRescheduled = db.prepare("UPDATE appointment SET internal_status = 'rescheduled' WHERE id = ?");

  // One per day and phone; your own events are left out.
  const read = new Map<string, { e: UnitrustEvent; name: string; phone: string }>();
  for (const e of events) {
    const t = parseUnitrustTitle(e.title);
    const key = t ? `${e.date}|${t.phone}` : null;
    if (t && key && !read.has(key)) read.set(key, { e, name: t.name, phone: t.phone });
  }

  /** Yellow: a reschedule (and the appointment it replaced is marked) or a sat-no-sale. */
  const yellow = (apptId: string, leadId: string, day: string): ApptResult => {
    const before = earlier.all(leadId, apptId, day) as { id: string; day: string; unitrust_key: string | null; result: string | null }[];
    const gone = before.filter((a) => shown.has(a.day) && a.unitrust_key && !read.has(a.unitrust_key));
    if (!gone.length && day <= today) return 'sat_no_sale';
    const pending = before.find((a) => a.result == null || a.result === 'cleared' || a.result === 'rescheduled');
    for (const a of gone.length ? gone : pending ? [pending] : []) markRescheduled.run(a.id);
    return 'rescheduled';
  };

  db.transaction(() => {
    for (const [key, { e, name, phone }] of read) {
      sync.seen++;
      const scheduled = e.time ? `${e.date}T${e.time}` : e.date;
      const existing = byKey.get(key) as { id: string; lead_id: string } | undefined;
      const leadId = existing?.lead_id ?? findLead(db, phone, name);
      if (!leadId) {
        sync.unmatched.push(e.title);
        continue;
      }
      sync.matched++;
      let apptId = existing?.id;
      if (apptId) {
        updateAppt.run(scheduled, e.title, apptId);
      } else {
        apptId = uuidv7();
        insertAppt.run({ id: apptId, lead_id: leadId, scheduled_for: scheduled, created_at: now, unitrust_key: key, title: e.title });
        sync.added++;
        touched.add(leadId);
      }
      const was = (current.get(apptId) as { result: string } | undefined)?.result ?? null;
      const result: ApptResult =
        e.color === 'yellow'
          ? was === 'sat_no_sale' ? was
            // A rescheduled appointment still yellow after its day was sat with no sale (Unitrust keeps it yellow).
            : was === 'rescheduled' ? (e.date < today ? 'sat_no_sale' : was)
            : yellow(apptId, leadId, e.date)
          : resultOfColor(e.color) ?? 'not_set';
      const add = storedResult(result, was);
      if (add) {
        insertResult.run(uuidv7(), apptId, add, now);
        if (existing) sync.changed++;
        touched.add(leadId);
      }
    }
    sync.unmatched = sync.unmatched.slice(0, 100);
    setSetting(db, SETTING, sync);
  })();
  if (touched.size) rebuildLeadState(db, [...touched], now);
  return sync;
}

/** The result row to add when the color now means `result` and the newest row says `was`, or null for no change. */
function storedResult(result: ApptResult, was: string | null): string | null {
  if (result === 'not_set') return was && was !== 'cleared' ? 'cleared' : null;
  return result === was ? null : result;
}

/** The lead an event is for: by phone (narrowed by name when several share it), else by exact full name. */
function findLead(db: DB, phoneDigits: string, name: string): string | null {
  const upper = name.toUpperCase().replace(/\s+/g, ' ').trim();
  const fullName = `upper(${LEAD_NAME})`;
  const e164 = normalizeUsPhone(phoneDigits).value;
  if (e164) {
    const byPhone = db
      .prepare(
        `SELECT l.id, ${fullName} name, upper(coalesce(l.last_name,'')) last FROM lead l
         LEFT JOIN lead_state s ON s.lead_id = l.id
         WHERE l.id IN (SELECT lead_id FROM lead_number WHERE e164 = ?)
         ORDER BY s.last_call_at DESC NULLS LAST, l.created_at DESC`,
      )
      .all(e164) as { id: string; name: string; last: string }[];
    if (byPhone.length === 1) return byPhone[0]!.id;
    if (byPhone.length > 1) {
      return (byPhone.find((r) => r.name === upper) ?? byPhone.find((r) => r.last && upper.endsWith(` ${r.last}`)) ?? byPhone[0]!).id;
    }
  }
  const byName = db.prepare(`SELECT l.id FROM lead l WHERE ${fullName} = ? LIMIT 2`).all(upper) as { id: string }[];
  return byName.length === 1 ? byName[0]!.id : null;
}

// ---------- for Reports, the funnel and the top bar ----------

/** How one appointment went, for counting: rescheduled means it was moved to another day. */
export type ApptOutcome = Exclude<ApptResult, 'not_set'> | 'pending';

export interface ApptRow {
  /** The Unitrust appointment's id, or the call's id for an appointment logged only here. */
  id: string;
  lead_id: string;
  lead_name: string;
  lead_type: string | null;
  day: string;
  time: string | null;
  title: string | null;
  outcome: ApptOutcome;
  /** Where the outcome came from: an appointment call logged here, or the Unitrust color. */
  source: 'app' | 'unitrust';
}

/** Appointment calls logged here (not undone), with their current outcome. */
const APP_CALLS = `
  SELECT c.id, c.lead_id, c.requested_at, date(c.requested_at, 'localtime') day, o.outcome_code
  FROM call c JOIN call_outcome o ON o.call_id = c.id AND ${CURRENT_OUTCOME}
  JOIN outcome_code oc ON oc.code = o.outcome_code
  WHERE c.voided_at IS NULL AND c.initiation_result = 'accepted' AND oc.kind = 'appointment'`;

/**
 * Appointments on the days from `fromDay` to `toDay` (YYYY-MM-DD, both included), optionally only some leads.
 * A Unitrust appointment takes the outcome you logged here for it (the latest appointment call on or after its day,
 * before the lead's next appointment), else its color. An appointment call with no Unitrust appointment behind it
 * counts on the day of the call.
 */
export function appointmentsOnDays(db: DB, fromDay: string, toDay: string, leadWhere = { sql: '1', params: {} as Record<string, unknown> }): ApptRow[] {
  const scheduled = "a2.lead_id = a.lead_id AND a2.recorded_via = 'unitrust' AND a2.internal_status = 'scheduled'";
  const rows = db
    .prepare(
      `WITH app AS (${APP_CALLS})
       SELECT a.id, a.lead_id, ${LEAD_NAME} lead_name, l.lead_type,
              substr(a.scheduled_for, 1, 10) day, CASE WHEN length(a.scheduled_for) > 10 THEN substr(a.scheduled_for, 12, 5) END time,
              a.title, a.internal_status,
              (SELECT result FROM appointment_result r WHERE r.appointment_id = a.id ORDER BY entered_at DESC, id DESC LIMIT 1) result,
              (SELECT app.outcome_code FROM app WHERE app.lead_id = a.lead_id AND app.day >= substr(a.scheduled_for, 1, 10)
                 AND NOT EXISTS (SELECT 1 FROM appointment a2 WHERE ${scheduled}
                   AND substr(a2.scheduled_for, 1, 10) > substr(a.scheduled_for, 1, 10) AND substr(a2.scheduled_for, 1, 10) <= app.day)
               ORDER BY app.requested_at DESC LIMIT 1) app_code
       FROM appointment a JOIN lead l ON l.id = a.lead_id
       WHERE a.recorded_via = 'unitrust' AND substr(a.scheduled_for, 1, 10) BETWEEN @from AND @to AND ${leadWhere.sql}
       ORDER BY a.scheduled_for, lead_name`,
    )
    .all({ ...leadWhere.params, from: fromDay, to: toDay }) as (Omit<ApptRow, 'outcome' | 'source'> & { internal_status: string; result: string | null; app_code: string | null })[];
  const fromUnitrust: ApptRow[] = rows.map(({ internal_status, result, app_code, ...r }) => {
    const app = outcomeDef(app_code)?.apptResult ?? undefined;
    return {
      ...r,
      source: app ? 'app' : 'unitrust',
      outcome: internal_status === 'rescheduled' ? 'rescheduled'
        : app ?? (result === 'sold' || result === 'no_show' || result === 'sat_no_sale' ? result : 'pending'),
    };
  });
  // Appointment calls with no Unitrust appointment on or before their day.
  const own = db
    .prepare(
      `WITH app AS (${APP_CALLS})
       SELECT app.id, app.lead_id, ${LEAD_NAME} lead_name, l.lead_type, app.day, app.outcome_code
       FROM app JOIN lead l ON l.id = app.lead_id
       WHERE app.day BETWEEN @from AND @to AND ${leadWhere.sql}
         AND NOT EXISTS (SELECT 1 FROM appointment a WHERE a.lead_id = app.lead_id AND a.recorded_via = 'unitrust' AND substr(a.scheduled_for, 1, 10) <= app.day)
       ORDER BY app.requested_at`,
    )
    .all({ ...leadWhere.params, from: fromDay, to: toDay }) as { id: string; lead_id: string; lead_name: string; lead_type: string | null; day: string; outcome_code: string }[];
  const fromApp: ApptRow[] = own.map(({ outcome_code, ...r }) => ({
    ...r, time: null, title: null, source: 'app', outcome: outcomeDef(outcome_code)?.apptResult ?? 'pending',
  }));
  return [...fromUnitrust, ...fromApp].sort((x, y) => x.day.localeCompare(y.day) || x.lead_name.localeCompare(y.lead_name));
}

export function appointmentCounts(rows: ApptRow[]) {
  const n = (o: ApptOutcome) => rows.filter((r) => r.outcome === o).length;
  const reached = (step: 'sat' | 'prezis' | 'sales') => rows.filter((r) => r.outcome !== 'pending' && APPT_RESULTS[r.outcome].funnel.includes(step)).length;
  const sold = reached('sales');
  const prezis = reached('prezis');
  const sat = reached('sat');
  const noShow = n('no_show');
  return {
    appointments: rows.length,
    /** Picked up for the appointment: sat no sale, prezi or sale. */
    sat,
    /** Presented: prezi or sale. */
    prezis,
    sold,
    sat_no_sale: n('sat_no_sale'),
    prezi: n('prezi'),
    no_show: noShow,
    rescheduled: n('rescheduled'),
    pending: n('pending'),
    /** Of the appointments that happened or didn't: how many sat. */
    show_rate: sat + noShow ? sat / (sat + noShow) : null,
    /** Of the ones that sat: how many bought. */
    close_rate: sat ? sold / sat : null,
  };
}

/** Whether there are any appointments to count yet: from the extension, or appointment calls logged here. */
export function hasAppointments(db: DB): boolean {
  return !!db.prepare(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM appointment WHERE recorded_via = 'unitrust')
       OR EXISTS (SELECT 1 FROM call_outcome o JOIN outcome_code oc ON oc.code = o.outcome_code WHERE oc.kind = 'appointment')`,
  ).get();
}
