import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { getSetting, setSetting } from '../core/settings.js';
import { rebuildLeadState } from './leadState.js';
import { normalizeUsPhone } from './normalize.js';
import { parseUnitrustTitle, RESULT_FOR_COLOR, type ApptResult, type UnitrustColor } from '../../shared/appointments.js';

// Appointments read off the Unitrust calendar by the Firefox extension. Each event is matched to a lead by its phone
// (then by name), stored once per day and phone, and each change of color adds a result row. Leads whose appointment
// changed get their state rebuilt, so a no-show or yellow comes back to be called.

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

/** Stores what the extension saw on the calendar. Returns what it found. */
export function recordUnitrustEvents(db: DB, events: UnitrustEvent[], now = nowIso()): UnitrustSync {
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

  db.transaction(() => {
    const seenKeys = new Set<string>();
    for (const e of events) {
      const t = parseUnitrustTitle(e.title);
      if (!t) continue;
      const key = `${e.date}|${t.phone}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      sync.seen++;
      const scheduled = e.time ? `${e.date}T${e.time}` : e.date;
      const result = RESULT_FOR_COLOR[e.color];
      const existing = byKey.get(key) as { id: string; lead_id: string } | undefined;
      if (existing) {
        sync.matched++;
        updateAppt.run(scheduled, e.title, existing.id);
        const was = (current.get(existing.id) as { result: string } | undefined)?.result ?? null;
        const add = storedResult(result, was);
        if (add) {
          insertResult.run(uuidv7(), existing.id, add, now);
          sync.changed++;
          touched.add(existing.lead_id);
        }
        continue;
      }
      const leadId = findLead(db, t.phone, t.name);
      if (!leadId) {
        sync.unmatched.push(e.title);
        continue;
      }
      sync.matched++;
      sync.added++;
      const id = uuidv7();
      insertAppt.run({ id, lead_id: leadId, scheduled_for: scheduled, created_at: now, unitrust_key: key, title: e.title });
      if (result !== 'not_set') insertResult.run(uuidv7(), id, result, now);
      touched.add(leadId);
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
  const fullName = "upper(trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')))";
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
