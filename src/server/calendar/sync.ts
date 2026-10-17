import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';
import { DomainError } from '../domain/calls.js';
import { GoogleApiError, GoogleAuthError, type CalendarEvent, type GoogleCalendar } from './google.js';

// Putting appointments on Google Calendar the Unitrust way:
//  1. a 30-minute event named "#MP <lead ID> <LAST NAME>" with your note in it;
//  2. Unitrust's calendar integration replaces it with its own event (App_Management link, LEAD ID, BORROWER, ...);
//  3. this worker spots that event by its LEAD ID line and puts your note on top. Unitrust's text stays as it was.
// Google can only push changes to a public web address, which this app doesn't have, so the worker checks every minute.

export const EVENT_MINUTES = 30;
/** Our marker in front of the note, and the line after it. Both are needed to recognise (and replace) the note. */
export const NOTE_START = '📝 CRM note:';
export const NOTE_END = '────────';
/** How far Unitrust's event time may be from the appointment and still count as the same appointment. */
const MATCH_WINDOW_MS = 24 * 3600_000;
/** After this long without Unitrust's event, Today shows a warning. */
export const UNITRUST_WAIT_WARN_MS = 2 * 3600_000;
/** If Unitrust keeps wiping the note, stop after this many re-adds so the two systems don't fight. */
export const MAX_REAPPLY = 3;
const FULL_SCAN_EVERY_MS = 15 * 60_000;
const OUR_PROP = 'mpcrm_appointment';
const NOT_EDITABLE = "Google wouldn't let the app change Unitrust's event (it may belong to Unitrust's calendar, not yours). Your note is on the lead in the CRM.";

export interface SyncRow {
  appointment_id: string;
  lead_id: string;
  source_lead_id: string;
  title: string;
  starts_at: string;
  note: string | null;
  state: 'queued' | 'waiting' | 'noted' | 'done' | 'cancel' | 'canceled' | 'failed';
  our_event_id: string;
  our_event_created_at: string | null;
  unitrust_event_id: string | null;
  unitrust_url: string | null;
  unitrust_start: string | null;
  unitrust_found_at: string | null;
  note_applied_at: string | null;
  reapply_count: number;
  unitrust_left_after_cancel: number;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- the note block ----------

const HTML_RE = /<\/?(br|p|div|span|b|strong|i|em|u|a|ul|ol|li|html|body)\b[^>]*>/i;

export function looksLikeHtml(s: string) {
  return HTML_RE.test(s);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Removes our note block (marker to end line, and the blank space after it). Leaves everything else alone. */
export function stripNote(desc: string): string {
  const s = desc.indexOf(NOTE_START);
  if (s < 0) return desc;
  const e = desc.indexOf(NOTE_END, s);
  if (e < 0) return desc; // half a block: don't guess, leave the text as it is
  let end = e + NOTE_END.length;
  const rest = desc.slice(end).match(/^(?:\s|<br\s*\/?>|&nbsp;)*/i);
  end += rest ? rest[0].length : 0;
  // Our block is always at the very top; if a tag opened just before it (Google wraps edits in HTML), keep that tag.
  return desc.slice(0, s) + desc.slice(end);
}

/** The description with your note on top. An empty note just removes ours. */
export function withNote(desc: string, note: string | null): string {
  const base = stripNote(desc ?? '');
  const text = (note ?? '').replace(new RegExp(NOTE_END, 'g'), '—').trim();
  if (!text) return base;
  if (looksLikeHtml(base)) return `${NOTE_START} ${escapeHtml(text).replace(/\r?\n/g, '<br>')}<br>${NOTE_END}<br><br>${base}`;
  return `${NOTE_START} ${text}\n${NOTE_END}\n\n${base}`;
}

/** Description as plain text, for reading Unitrust's fields out of it. */
export function plainText(desc: string): string {
  return desc
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** LEAD ID and App_Management link from a Unitrust event. */
export function readUnitrust(desc: string | undefined): { leadId: string | null; url: string | null } {
  if (!desc) return { leadId: null, url: null };
  const t = plainText(stripNote(desc));
  const id = t.match(/^\s*LEAD\s*ID\s*:\s*([0-9A-Za-z-]+)/im)?.[1] ?? null;
  const url = t.match(/^\s*App_Management\s*:\s*(https:\/\/[^\s<>"]+)/im)?.[1] ?? null;
  return { leadId: id, url };
}

// ---------- making the event ----------

/** Event title: "#MP 503534129 COX". */
export function eventTitle(sourceLeadId: string, lastName: string) {
  return `#MP ${sourceLeadId} ${lastName.trim().toUpperCase()}`.trim();
}

/** Last name for the title: the last-name field, or else the last word of the name as it was imported. */
export function lastNameOf(lead: { last_name?: string | null; full_name_raw?: string | null; first_name?: string | null }) {
  if (lead.last_name?.trim()) return lead.last_name.trim();
  const words = (lead.full_name_raw ?? '').trim().split(/\s+/).filter(Boolean);
  return words.at(-1) ?? '';
}

/** The id we give our #MP event. Google accepts lowercase a–v and digits; a hex UUID fits. A retry reuses it. */
export function ourEventId(appointmentId: string) {
  return `mpcrm${appointmentId.replace(/-/g, '').toLowerCase()}`;
}

function log(db: DB, appointmentId: string, kind: string, detail?: string | null) {
  db.prepare('INSERT INTO calendar_sync_event (id, appointment_id, at, kind, detail) VALUES (?,?,?,?,?)').run(
    uuidv7(), appointmentId, nowIso(), kind, detail ?? null,
  );
}

function setRow(db: DB, id: string, patch: Partial<SyncRow>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE calendar_sync SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE appointment_id = @id`).run({
    ...patch,
    updated_at: nowIso(),
    id,
  });
}

export function getSyncRow(db: DB, appointmentId: string) {
  return db.prepare('SELECT * FROM calendar_sync WHERE appointment_id = ?').get(appointmentId) as SyncRow | undefined;
}

/**
 * Which lead ID goes in the title. Uses the one on the lead; if the lead has none and you typed one, saves it on the
 * lead (the old value is kept in the lead's change history). Throws when there's none, because Unitrust needs it.
 */
export function resolveSourceLeadId(db: DB, leadId: string, typed?: string | null): string {
  const lead = db.prepare('SELECT source_lead_id FROM lead WHERE id = ?').get(leadId) as { source_lead_id: string | null } | undefined;
  if (!lead) throw new DomainError('lead not found', 404);
  if (lead.source_lead_id?.trim()) return lead.source_lead_id.trim();
  const v = (typed ?? '').trim();
  if (!v) throw new DomainError('Enter the lead ID: Unitrust needs it in the calendar event.');
  if (!/^[0-9A-Za-z-]{3,40}$/.test(v)) throw new DomainError('The lead ID should be the number from the lead page (digits only).');
  return v;
}

/** Saves a typed lead ID on a lead that had none. Call inside the booking transaction. */
export function saveSourceLeadId(db: DB, leadId: string, value: string) {
  const lead = db.prepare('SELECT source_lead_id FROM lead WHERE id = ?').get(leadId) as { source_lead_id: string | null };
  if (lead.source_lead_id?.trim()) return;
  db.prepare('UPDATE lead SET source_lead_id = ? WHERE id = ?').run(value, leadId);
  db.prepare('INSERT INTO lead_change (id, lead_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?)').run(
    uuidv7(), leadId, 'source_lead_id', null, value, nowIso(),
  );
}

/** Queues an appointment for the calendar. Safe to call twice: the second call does nothing. */
export function queueAppointment(db: DB, appointmentId: string, opts: { note: string | null; sourceLeadId: string }) {
  const a = db
    .prepare('SELECT a.id, a.lead_id, a.scheduled_for, l.last_name, l.first_name, l.full_name_raw FROM appointment a JOIN lead l ON l.id = a.lead_id WHERE a.id = ?')
    .get(appointmentId) as any;
  if (!a) throw new DomainError('appointment not found', 404);
  if (!a.scheduled_for) throw new DomainError('the appointment needs a time to go on the calendar');
  if (getSyncRow(db, appointmentId)) return;
  const now = nowIso();
  db.prepare(
    `INSERT INTO calendar_sync (appointment_id, lead_id, source_lead_id, title, starts_at, note, state, our_event_id, next_attempt_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'queued', ?, ?, ?, ?)`,
  ).run(appointmentId, a.lead_id, opts.sourceLeadId, eventTitle(opts.sourceLeadId, lastNameOf(a)), a.scheduled_for, opts.note?.trim() || null, ourEventId(appointmentId), now, now, now);
  log(db, appointmentId, 'queued');
}

/**
 * The call that set the appointment was undone. Not sent yet: dropped. Already on the calendar: the #MP event is
 * deleted. Returns true when Unitrust already made its own event, which only Unitrust can cancel.
 */
export function cancelAppointment(db: DB, appointmentId: string): { unitrust_has_it: boolean } {
  const r = getSyncRow(db, appointmentId);
  if (!r) return { unitrust_has_it: false };
  if (r.state === 'queued' || r.state === 'failed') {
    setRow(db, appointmentId, { state: 'canceled' });
    log(db, appointmentId, 'canceled', 'never sent');
    return { unitrust_has_it: false };
  }
  if (r.state === 'canceled' || r.state === 'cancel') return { unitrust_has_it: !!r.unitrust_event_id };
  const has = !!r.unitrust_event_id;
  setRow(db, appointmentId, { state: 'cancel', unitrust_left_after_cancel: has ? 1 : 0, next_attempt_at: nowIso(), attempts: 0 });
  log(db, appointmentId, 'cancel_requested', has ? 'Unitrust already has its own event' : null);
  return { unitrust_has_it: has };
}

/** Rescheduled from Today: a new #MP event for the new time, with the same note. Unitrust handles its old event. */
export function rescheduleAppointment(db: DB, oldId: string, newId: string) {
  const r = getSyncRow(db, oldId);
  if (!r) return false;
  queueAppointment(db, newId, { note: r.note, sourceLeadId: r.source_lead_id });
  log(db, oldId, 'rescheduled', newId);
  return true;
}

/** Changes the note. The worker puts the new one on Unitrust's event (or on the #MP event if Unitrust hasn't replaced it). */
export function changeNote(db: DB, appointmentId: string, note: string | null) {
  const r = getSyncRow(db, appointmentId);
  if (!r) throw new DomainError('this appointment is not on your calendar', 404);
  const text = note?.trim() || null;
  if (text && text.length > 4000) throw new DomainError('the note is too long');
  const patch: Partial<SyncRow> = { note: text, next_attempt_at: nowIso() };
  if (r.state === 'done' && r.unitrust_event_id) patch.state = 'noted';
  if (r.state === 'failed' && r.last_error?.startsWith('Unitrust keeps')) Object.assign(patch, { state: 'noted', reapply_count: 0, last_error: null });
  setRow(db, appointmentId, patch);
  log(db, appointmentId, 'note_changed');
}

/** Try a failed or stuck event again. */
export function retry(db: DB, appointmentId: string) {
  const r = getSyncRow(db, appointmentId);
  if (!r) throw new DomainError('this appointment is not on your calendar', 404);
  if (r.state === 'failed') {
    setRow(db, appointmentId, {
      state: r.our_event_created_at ? (r.unitrust_event_id ? 'noted' : 'waiting') : 'queued',
      attempts: 0, next_attempt_at: nowIso(), last_error: null, reapply_count: 0,
    });
  } else setRow(db, appointmentId, { attempts: 0, next_attempt_at: nowIso() });
  log(db, appointmentId, 'retry');
}

/** Makes the CRM appointment match the time on Unitrust's event. The old time is kept in the audit log. */
export function useUnitrustTime(db: DB, appointmentId: string) {
  return db.transaction(() => {
    const r = getSyncRow(db, appointmentId);
    if (!r?.unitrust_start) throw new DomainError('Unitrust has no time for this appointment yet', 404);
    const a = db.prepare('SELECT * FROM appointment WHERE id = ?').get(appointmentId) as any;
    db.prepare('UPDATE appointment SET scheduled_for = ? WHERE id = ?').run(r.unitrust_start, appointmentId);
    db.prepare('INSERT INTO audit_log (id, at, table_name, row_id, action, old_json, new_json) VALUES (?,?,?,?,?,?,?)').run(
      uuidv7(), nowIso(), 'appointment', appointmentId, 'time_from_unitrust',
      JSON.stringify({ scheduled_for: a.scheduled_for }), JSON.stringify({ scheduled_for: r.unitrust_start }),
    );
    setRow(db, appointmentId, { starts_at: r.unitrust_start });
    log(db, appointmentId, 'time_from_unitrust', `${a.scheduled_for} → ${r.unitrust_start}`);
    return { scheduled_for: r.unitrust_start };
  })();
}

// ---------- what Today and Settings show ----------

export interface CalendarProblem {
  appointment_id: string;
  lead_id: string;
  name: string;
  scheduled_for: string | null;
  kind: 'failed' | 'not_sent' | 'unitrust_missing' | 'unitrust_after_undo' | 'time_differs';
  message: string;
  unitrust_start?: string | null;
}

export function calendarProblems(db: DB, now = Date.now()): CalendarProblem[] {
  const rows = db
    .prepare(
      `SELECT cs.*, a.scheduled_for, a.internal_status, trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) name
       FROM calendar_sync cs JOIN appointment a ON a.id = cs.appointment_id JOIN lead l ON l.id = cs.lead_id
       WHERE cs.state <> 'done' OR cs.unitrust_start IS NOT NULL
       ORDER BY cs.starts_at`,
    )
    .all() as (SyncRow & { scheduled_for: string | null; internal_status: string; name: string })[];
  const out: CalendarProblem[] = [];
  const iso = new Date(now).toISOString();
  for (const r of rows) {
    const base = { appointment_id: r.appointment_id, lead_id: r.lead_id, name: r.name, scheduled_for: r.scheduled_for };
    const upcoming = (r.scheduled_for ?? r.starts_at) > iso;
    if (r.state === 'failed') out.push({ ...base, kind: 'failed', message: r.last_error ?? 'Google refused the event.' });
    else if (r.state === 'queued' && r.attempts > 0) out.push({ ...base, kind: 'not_sent', message: `Not on your calendar yet: ${r.last_error ?? 'Google could not be reached'}. The app keeps trying.` });
    else if (r.state === 'waiting' && r.our_event_created_at && now - Date.parse(r.our_event_created_at) > UNITRUST_WAIT_WARN_MS && upcoming) {
      out.push({ ...base, kind: 'unitrust_missing', message: `Unitrust hasn't replaced "${r.title}" yet, so your note is only on that event. Check the appointment in Unitrust.` });
    } else if ((r.state === 'canceled' || r.state === 'cancel') && r.unitrust_left_after_cancel && upcoming) {
      out.push({ ...base, kind: 'unitrust_after_undo', message: 'You undid this appointment, but Unitrust had already booked it. Cancel it in Unitrust.' });
    }
    if (
      r.unitrust_start && r.scheduled_for && r.internal_status !== 'canceled' && !['canceled', 'cancel'].includes(r.state) && upcoming &&
      Math.abs(Date.parse(r.unitrust_start) - Date.parse(r.scheduled_for)) > 60_000
    ) {
      out.push({ ...base, kind: 'time_differs', message: 'Unitrust has a different time for this appointment.', unitrust_start: r.unitrust_start });
    }
  }
  return out;
}

// ---------- the worker ----------

function startIso(ev: CalendarEvent): string | null {
  const v = ev.start?.dateTime ?? ev.start?.date;
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function backoffMs(attempts: number) {
  return [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000][attempts - 1] ?? 30 * 60_000;
}

export class CalendarWorker {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastScanAt: number | null = null;
  private lastFullScanAt = 0;
  private now: () => number;
  /** Last problem talking to Google, for Settings. */
  lastError: string | null = null;
  lastRunAt: string | null = null;

  constructor(
    private db: DB,
    private google: GoogleCalendar,
    opts: { now?: () => number; log?: (msg: string, extra?: unknown) => void } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.logFn = opts.log ?? (() => {});
  }
  private logFn: (msg: string, extra?: unknown) => void;

  start(everyMs = 60_000) {
    this.stop();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
    setTimeout(() => void this.tick(), 5_000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run soon (after a booking), without waiting for the next minute. */
  kick() {
    setImmediate(() => void this.tick());
  }

  /** One round: send new events, delete undone ones, look for Unitrust's events and put notes on them. */
  async tick(): Promise<void> {
    if (this.running || !this.google.connected()) return;
    this.running = true;
    try {
      await this.sendQueued();
      await this.sendCancels();
      await this.pushChangedNotes();
      await this.scan();
      this.finishOld();
      this.lastError = null;
    } catch (e: any) {
      this.lastError = e.message;
      if (!(e instanceof GoogleAuthError)) this.logFn('calendar sync failed', { err: e.message });
    } finally {
      this.lastRunAt = new Date(this.now()).toISOString();
      this.running = false;
    }
  }

  private due(state: SyncRow['state']) {
    return this.db
      .prepare('SELECT * FROM calendar_sync WHERE state = ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at')
      .all(state, new Date(this.now()).toISOString()) as SyncRow[];
  }

  /** Temporary trouble waits and tries again; a hard "no" from Google marks the row failed. Sign-in trouble stops the round. */
  private failed(r: SyncRow, e: unknown, keepState: SyncRow['state']) {
    if (e instanceof GoogleAuthError) throw e;
    const msg = (e as Error).message;
    if (e instanceof GoogleApiError && !e.temporary) {
      setRow(this.db, r.appointment_id, { state: 'failed', last_error: msg });
      log(this.db, r.appointment_id, 'error', msg);
      return;
    }
    const attempts = r.attempts + 1;
    setRow(this.db, r.appointment_id, {
      state: keepState, attempts, last_error: msg,
      next_attempt_at: new Date(this.now() + backoffMs(attempts)).toISOString(),
    });
    if (e instanceof GoogleApiError && e.status === 0) throw e; // offline: no point trying the rest now
  }

  private async sendQueued() {
    for (const r of this.due('queued')) {
      const start = Date.parse(r.starts_at);
      try {
        await this.google.insertEvent({
          id: r.our_event_id,
          summary: r.title,
          description: r.note ?? '',
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(start + EVENT_MINUTES * 60_000).toISOString() },
          extendedProperties: { private: { [OUR_PROP]: r.appointment_id } },
        });
        setRow(this.db, r.appointment_id, { state: 'waiting', our_event_created_at: nowIso(this.now), attempts: 0, last_error: null, next_attempt_at: null });
        log(this.db, r.appointment_id, 'created', r.title);
      } catch (e) {
        if (e instanceof GoogleApiError && e.status === 409) {
          // Already made on an earlier try whose answer got lost (Unitrust may even have replaced it since).
          setRow(this.db, r.appointment_id, { state: 'waiting', our_event_created_at: r.our_event_created_at ?? nowIso(this.now), attempts: 0, last_error: null, next_attempt_at: null });
          log(this.db, r.appointment_id, 'created', 'already there');
        } else this.failed(r, e, 'queued');
      }
    }
  }

  private async sendCancels() {
    for (const r of this.due('cancel')) {
      try {
        await this.google.deleteEvent(r.our_event_id);
        log(this.db, r.appointment_id, 'deleted', r.title);
      } catch (e) {
        if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) {
          this.failed(r, e, 'cancel');
          continue;
        }
        log(this.db, r.appointment_id, 'deleted', 'already gone');
      }
      setRow(this.db, r.appointment_id, { state: 'canceled', attempts: 0, last_error: null, next_attempt_at: null });
    }
  }

  /** Notes you changed after booking. */
  private async pushChangedNotes() {
    const rows = this.db
      .prepare("SELECT * FROM calendar_sync WHERE state IN ('waiting','noted') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?")
      .all(new Date(this.now()).toISOString()) as SyncRow[];
    for (const r of rows) {
      try {
        if (r.unitrust_event_id) {
          const ev = await this.google.getEvent(r.unitrust_event_id);
          await this.applyNote(r, ev, false);
        } else {
          try {
            await this.google.patchEvent(r.our_event_id, { description: r.note ?? '' });
          } catch (e) {
            // Unitrust replaced it in the meantime: the scan finds Unitrust's event and puts the note there.
            if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) throw e;
          }
        }
        setRow(this.db, r.appointment_id, { next_attempt_at: null, attempts: 0, last_error: null });
      } catch (e) {
        if (e instanceof GoogleApiError && (e.status === 404 || e.status === 410) && r.unitrust_event_id) {
          // Unitrust's event is gone (canceled there, or replaced). Look for it again.
          setRow(this.db, r.appointment_id, { state: 'waiting', unitrust_event_id: null, next_attempt_at: null });
          log(this.db, r.appointment_id, 'unitrust_gone');
        } else this.failed(r, e, r.state);
      }
    }
  }

  /** Looks through recent calendar changes for Unitrust's events. */
  private async scan() {
    const watched = this.db
      .prepare(
        `SELECT * FROM calendar_sync WHERE state IN ('waiting','noted')
           OR (state IN ('cancel','canceled') AND our_event_created_at IS NOT NULL AND unitrust_left_after_cancel = 0 AND starts_at > ?)`,
      )
      .all(new Date(this.now() - MATCH_WINDOW_MS).toISOString()) as SyncRow[];
    if (!watched.length) return;
    const times = watched.map((r) => Date.parse(r.starts_at));
    const now = this.now();
    const full = this.lastScanAt === null || now - this.lastFullScanAt >= FULL_SCAN_EVERY_MS;
    const events = await this.google.listEvents({
      timeMin: new Date(Math.min(...times) - MATCH_WINDOW_MS).toISOString(),
      timeMax: new Date(Math.max(...times) + MATCH_WINDOW_MS).toISOString(),
      // Only what changed since last time (with a margin for clock differences), except for a full look every 15 minutes.
      updatedMin: full ? null : new Date(this.lastScanAt! - 5 * 60_000).toISOString(),
    });
    this.lastScanAt = now;
    if (full) this.lastFullScanAt = now;

    for (const ev of events) {
      if (ev.status === 'cancelled') continue;
      if (ev.extendedProperties?.private?.[OUR_PROP]) continue; // one of our own #MP events
      const { leadId, url } = readUnitrust(ev.description);
      if (!leadId) continue;
      const start = startIso(ev);
      const candidates = watched.filter((r) => r.source_lead_id === leadId);
      const r =
        candidates.find((c) => c.unitrust_event_id === ev.id) ??
        candidates
          .filter((c) => !c.unitrust_event_id && start && Math.abs(Date.parse(c.starts_at) - Date.parse(start)) <= MATCH_WINDOW_MS)
          .sort((a, b) => Math.abs(Date.parse(a.starts_at) - Date.parse(start!)) - Math.abs(Date.parse(b.starts_at) - Date.parse(start!)))[0];
      if (!r) continue;
      watched.splice(watched.indexOf(r), 1, { ...r, unitrust_event_id: ev.id }); // one event per appointment this round
      await this.found(r, ev, url, start);
    }
  }

  private async found(r: SyncRow, ev: CalendarEvent, url: string | null, start: string | null) {
    const first = r.unitrust_event_id !== ev.id;
    const patch: Partial<SyncRow> = {};
    if (first) Object.assign(patch, { unitrust_event_id: ev.id, unitrust_found_at: nowIso(this.now) });
    if (url && url !== r.unitrust_url) patch.unitrust_url = url;
    if (start && start !== r.unitrust_start) patch.unitrust_start = start;
    if (r.state === 'cancel' || r.state === 'canceled') {
      setRow(this.db, r.appointment_id, { ...patch, unitrust_left_after_cancel: 1 });
      log(this.db, r.appointment_id, 'found_unitrust', 'after the call was undone');
      return;
    }
    setRow(this.db, r.appointment_id, patch);
    if (first) log(this.db, r.appointment_id, 'found_unitrust', ev.id);
    try {
      await this.applyNote({ ...r, ...patch }, ev, true);
    } catch (e) {
      this.failed({ ...r, ...patch } as SyncRow, e, r.state);
    }
  }

  /** Puts the note on top of Unitrust's event if it isn't there already. Only the description changes. */
  private async applyNote(r: SyncRow, ev: CalendarEvent, fromScan: boolean) {
    const current = ev.description ?? '';
    const wanted = withNote(current, r.note);
    if (wanted === current) {
      if (r.state !== 'noted') setRow(this.db, r.appointment_id, { state: 'noted', note_applied_at: r.note_applied_at ?? nowIso(this.now) });
      return;
    }
    // Unitrust wrote over a note we had already added: put it back, but not forever.
    const rewritten = fromScan && !!r.note_applied_at && !current.includes(NOTE_START);
    if (rewritten && r.reapply_count >= MAX_REAPPLY) {
      setRow(this.db, r.appointment_id, { state: 'failed', last_error: 'Unitrust keeps rewriting its event and removing your note, so the app stopped adding it.' });
      log(this.db, r.appointment_id, 'gave_up');
      return;
    }
    let saved: CalendarEvent | undefined;
    try {
      saved = await this.google.patchEvent(ev.id, { description: wanted });
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 403) throw new GoogleApiError(NOT_EDITABLE, 403);
      throw e;
    }
    // Google quietly ignores description changes from a guest; if that happens, say so instead of retrying.
    if (saved && typeof saved.description === 'string' && r.note && !saved.description.includes(NOTE_START)) {
      throw new GoogleApiError(NOT_EDITABLE, 403);
    }
    setRow(this.db, r.appointment_id, {
      state: 'noted',
      note_applied_at: nowIso(this.now),
      reapply_count: r.reapply_count + (rewritten ? 1 : 0),
      last_error: null,
    });
    log(this.db, r.appointment_id, rewritten ? 'note_readded' : r.note_applied_at ? 'note_updated' : 'note_added');
  }

  /** Stops watching appointments that are over. */
  private finishOld() {
    const now = this.now();
    this.db
      .prepare("UPDATE calendar_sync SET state = 'done', updated_at = ? WHERE state = 'noted' AND starts_at < ? AND next_attempt_at IS NULL")
      .run(new Date(now).toISOString(), new Date(now).toISOString());
    // Unitrust never picked it up and the day has passed: nothing more to watch for.
    this.db
      .prepare("UPDATE calendar_sync SET state = 'done', last_error = 'Unitrust never replaced the event', updated_at = ? WHERE state = 'waiting' AND starts_at < ?")
      .run(new Date(now).toISOString(), new Date(now - MATCH_WINDOW_MS).toISOString());
  }
}
