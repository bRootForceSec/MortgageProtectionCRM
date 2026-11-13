import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { LEAD_NAME, CURRENT_NOTE } from '../db/sql.js';
import type { PrepCard } from '../../shared/appointments.js';

// The appointment time you can type on "Appt set" (optional). It's stored like a Unitrust appointment, in your own
// time ("YYYY-MM-DD", or "YYYY-MM-DDTHH:MM"), with recorded_via 'in_app_on_call'. Unitrust stays the official record:
// once the extension sends an appointment for the lead, that one counts and the typed one is only history.
// Counting and lead status still read Unitrust appointments only (unitrustAppointments.ts, leadState.ts).

const WALL = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d)?$/;

/**
 * Stores the time typed for the appointment set on this call. Call it inside the transaction that logs the call.
 * `onTheSpot`: you ran it right away on the same call ("Run it now"), so it's counted apart in Reports.
 */
export function recordAppointmentTime(
  db: DB, leadId: string, callId: string, fromNumberId: string | null, scheduledFor: string, now = nowIso(), onTheSpot = false,
) {
  if (!WALL.test(scheduledFor)) throw new DomainError('appointment time must look like 2026-10-30 or 2026-10-30T14:00');
  db.prepare(
    `INSERT INTO appointment (id, lead_id, scheduled_for, set_on_call_id, set_from_number_id, recorded_via, on_the_spot, created_at)
     VALUES (?, ?, ?, ?, ?, 'in_app_on_call', ?, ?)`,
  ).run(uuidv7(), leadId, scheduledFor, callId, fromNumberId, onTheSpot ? 1 : 0, now);
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

/**
 * SQL: true when the lead had an on-the-spot appointment (set and run on the same call, not undone) on that day.
 * `leadId` and `day` are SQL expressions; `day` is YYYY-MM-DD in your time.
 */
export const onTheSpotOn = (leadId: string, day: string) =>
  `EXISTS (SELECT 1 FROM appointment ots JOIN call otc ON otc.id = ots.set_on_call_id
     WHERE ots.lead_id = ${leadId} AND ots.on_the_spot = 1 AND ots.internal_status = 'scheduled' AND otc.voided_at IS NULL
       AND substr(ots.scheduled_for, 1, 10) = ${day})`;

/**
 * SQL over `appointment a LEFT JOIN call c ON c.id = a.set_on_call_id`: an appointment that still stands, from Unitrust
 * or typed on Appt set (not undone), where a time you typed drops out once Unitrust sends one for that lead. The newest
 * one per lead (by created_at) is the lead's appointment.
 */
export const STANDING_APPOINTMENT = `a.internal_status = 'scheduled' AND a.scheduled_for IS NOT NULL AND c.voided_at IS NULL
  AND a.recorded_via IN ('unitrust', 'in_app_on_call')
  AND NOT (a.recorded_via = 'in_app_on_call' AND EXISTS (
    SELECT 1 FROM appointment u WHERE u.lead_id = a.lead_id AND u.recorded_via = 'unitrust' AND u.created_at >= a.created_at))`;

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
       WHERE a.lead_id = ? AND ${STANDING_APPOINTMENT}
       ORDER BY a.created_at DESC LIMIT 1`,
    )
    .get(leadId) as { scheduled_for: string; recorded_via: string } | undefined;
  return r ? { scheduled_for: r.scheduled_for, source: r.recorded_via === 'unitrust' ? 'unitrust' : 'app' } : null;
}

/**
 * The appointments on one day (YYYY-MM-DD, your time), earliest first, by the same rule as `currentAppointment`:
 * a time you typed drops out once Unitrust sends an appointment for that lead. On-the-spot ones are left out: they
 * already ran on the call, so there's nothing to prepare or be alerted for.
 */
export function appointmentsOnDay(db: DB, day: string): PrepCard[] {
  return db
    .prepare(
      `SELECT a.id appointment_id, a.lead_id, a.scheduled_for, CASE a.recorded_via WHEN 'unitrust' THEN 'unitrust' ELSE 'app' END source,
              ${LEAD_NAME} name, l.phone_e164, l.city, l.state, l.time_zone, l.lead_type, l.lender, l.loan_amount_cents, l.dob, l.age,
              l.coborrower_raw, l.tobacco_raw, l.health_heart_raw, l.health_stroke_raw, l.health_cancer_raw, l.health_diabetes_raw,
              s.status, s.appt_result,
              (SELECT n.body FROM note n LEFT JOIN call nc ON nc.id = n.call_id
                WHERE n.lead_id = a.lead_id AND nc.voided_at IS NULL
                  AND ${CURRENT_NOTE}
                ORDER BY n.created_at DESC LIMIT 1) last_note
       FROM appointment a JOIN lead l ON l.id = a.lead_id LEFT JOIN lead_state s ON s.lead_id = a.lead_id
       LEFT JOIN call c ON c.id = a.set_on_call_id
       WHERE substr(a.scheduled_for, 1, 10) = ? AND a.internal_status = 'scheduled' AND c.voided_at IS NULL AND NOT ${onTheSpotOn('a.lead_id', 'substr(a.scheduled_for, 1, 10)')}
         AND a.recorded_via IN ('unitrust', 'in_app_on_call')
         AND NOT (a.recorded_via = 'in_app_on_call' AND EXISTS (
           SELECT 1 FROM appointment u WHERE u.lead_id = a.lead_id AND u.recorded_via = 'unitrust' AND u.created_at >= a.created_at))
       ORDER BY a.scheduled_for, name`,
    )
    .all(day) as PrepCard[];
}
