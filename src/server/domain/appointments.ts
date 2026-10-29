import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';
import { DomainError } from '../core/errors.js';

// The appointment time you can type on "Appt set" (optional). It's stored like a Unitrust appointment, in your own
// time ("YYYY-MM-DD", or "YYYY-MM-DDTHH:MM"), with recorded_via 'in_app_on_call'. Unitrust stays the official record:
// once the extension sends an appointment for the lead, that one counts and the typed one is only history.
// Counting and lead status still read Unitrust appointments only (unitrustAppointments.ts, leadState.ts).

const WALL = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d)?$/;

/** Stores the time typed for the appointment set on this call. Call it inside the transaction that logs the call. */
export function recordAppointmentTime(db: DB, leadId: string, callId: string, fromNumberId: string | null, scheduledFor: string, now = nowIso()) {
  if (!WALL.test(scheduledFor)) throw new DomainError('appointment time must look like 2026-10-30 or 2026-10-30T14:00');
  db.prepare(
    `INSERT INTO appointment (id, lead_id, scheduled_for, set_on_call_id, set_from_number_id, recorded_via, created_at)
     VALUES (?, ?, ?, ?, ?, 'in_app_on_call', ?)`,
  ).run(uuidv7(), leadId, scheduledFor, callId, fromNumberId, now);
}

/** The typed appointment time of a call, if it still stands. */
export function appointmentTimeOfCall(db: DB, callId: string): string | null {
  const r = db
    .prepare("SELECT scheduled_for FROM appointment WHERE set_on_call_id = ? AND recorded_via = 'in_app_on_call' AND internal_status = 'scheduled' ORDER BY created_at DESC LIMIT 1")
    .get(callId) as { scheduled_for: string } | undefined;
  return r?.scheduled_for ?? null;
}

/** Cancels the typed appointment of a call that was undone, or whose outcome is no longer an appointment set. */
export function cancelAppointmentsOfCall(db: DB, callId: string) {
  db.prepare("UPDATE appointment SET internal_status = 'canceled' WHERE set_on_call_id = ? AND recorded_via = 'in_app_on_call' AND internal_status = 'scheduled'").run(callId);
}

export interface NextAppointment {
  scheduled_for: string;
  /** Typed on Appt set ('app'), or read from the Unitrust calendar. */
  source: 'app' | 'unitrust';
}

/**
 * The lead's appointment as it stands: the newest scheduled one, where a Unitrust appointment wins over a time you
 * typed before it arrived. Null when there's none.
 */
export function currentAppointment(db: DB, leadId: string): NextAppointment | null {
  const r = db
    .prepare(
      `SELECT a.scheduled_for, a.recorded_via FROM appointment a
       LEFT JOIN call c ON c.id = a.set_on_call_id
       WHERE a.lead_id = ? AND a.internal_status = 'scheduled' AND a.scheduled_for IS NOT NULL AND c.voided_at IS NULL
         AND a.recorded_via IN ('unitrust', 'in_app_on_call')
         AND NOT (a.recorded_via = 'in_app_on_call' AND EXISTS (
           SELECT 1 FROM appointment u WHERE u.lead_id = a.lead_id AND u.recorded_via = 'unitrust' AND u.created_at >= a.created_at))
       ORDER BY a.created_at DESC LIMIT 1`,
    )
    .get(leadId) as { scheduled_for: string; recorded_via: string } | undefined;
  return r ? { scheduled_for: r.scheduled_for, source: r.recorded_via === 'unitrust' ? 'unitrust' : 'app' } : null;
}
