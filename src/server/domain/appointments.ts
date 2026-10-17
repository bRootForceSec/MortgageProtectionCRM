import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';
import { DomainError } from './calls.js';
import { rebuildLeadState } from './leadState.js';

// How appointments went: Sat no sale, Sold, No-show, Rescheduled, Canceled. These are your own notes for your numbers;
// the IMO site stays the official record. Results are append-only: a correction is a new row, and "cleared" takes one back.

export const APPOINTMENT_RESULTS = ['sat_no_sale', 'sold', 'no_show', 'rescheduled', 'canceled'] as const;
export type AppointmentResult = (typeof APPOINTMENT_RESULTS)[number];
export const RESULT_LABELS: Record<AppointmentResult, string> = {
  sat_no_sale: 'Sat, no sale',
  sold: 'Sold (app written)',
  no_show: 'No-show',
  rescheduled: 'Rescheduled',
  canceled: 'Canceled',
};

export { CURRENT_RESULT_SQL } from './leadState.js';

export function recordAppointmentResult(
  db: DB,
  appointmentId: string,
  input: { result: AppointmentResult | 'cleared'; rescheduled_for?: string | null; note?: string | null },
) {
  return db.transaction(() => {
    const appt = db.prepare('SELECT * FROM appointment WHERE id = ?').get(appointmentId) as any;
    if (!appt) throw new DomainError('appointment not found', 404);
    if (appt.internal_status === 'canceled' && /call undone/.test(appt.notes ?? '')) {
      throw new DomainError('the call that set this appointment was undone');
    }
    const now = nowIso();
    let newId: string | null = null;
    if (input.result === 'rescheduled') {
      const at = input.rescheduled_for ? new Date(input.rescheduled_for) : null;
      if (!at || Number.isNaN(at.getTime())) throw new DomainError('enter the new appointment time');
      newId = uuidv7();
      db.prepare(
        `INSERT INTO appointment (id, lead_id, scheduled_for, time_zone, set_from_number_id, recorded_via, notes, created_at)
         VALUES (?,?,?,?,?, 'manual', ?, ?)`,
      ).run(newId, appt.lead_id, at.toISOString(), appt.time_zone, appt.set_from_number_id, 'rescheduled', now);
    }
    const id = uuidv7();
    db.prepare(
      'INSERT INTO appointment_result (id, appointment_id, result, rescheduled_to, note, entered_at) VALUES (?,?,?,?,?,?)',
    ).run(id, appointmentId, input.result, newId, input.note?.trim() || null, now);
    rebuildLeadState(db, [appt.lead_id]);
    return { id, new_appointment_id: newId };
  })();
}

/** Every result entered for an appointment, newest first. */
export function appointmentResults(db: DB, appointmentId: string) {
  return db.prepare('SELECT * FROM appointment_result WHERE appointment_id = ? ORDER BY entered_at DESC, id DESC').all(appointmentId);
}
