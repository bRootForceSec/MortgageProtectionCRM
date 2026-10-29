import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { changeOutcome, currentOutcome, logManualCall, voidCall } from '../../src/server/domain/calls.js';
import { appointmentsOnDay, currentAppointment } from '../../src/server/domain/appointments.js';
import { DomainError } from '../../src/server/core/errors.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

// The optional appointment time on "Appt set". Unitrust stays the official record and wins once it sends one.

let db: DB;
let lead: string;
const key = () => `k-${uuidv7()}`;

beforeEach(async () => {
  ({ db } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  lead = (db.prepare("SELECT id FROM lead WHERE first_name = 'Robert'").get() as { id: string }).id;
});

const set = (appointment_for: string | null) =>
  logManualCall(db, { lead_id: lead, idempotency_key: key(), outcome_code: 'appointment', appointment_for }).call_id;

describe('appointment time on Appt set', () => {
  it('is optional, and kept in your time', () => {
    set(null);
    expect(currentAppointment(db, lead)).toBeNull();
    set('2099-10-30T14:00');
    expect(currentAppointment(db, lead)).toEqual({ scheduled_for: '2099-10-30T14:00', source: 'app' });
    set('2099-11-02');
    expect(currentAppointment(db, lead)).toEqual({ scheduled_for: '2099-11-02', source: 'app' });
  });

  it('refuses a time that is not one, or on an outcome that is not an appointment set', () => {
    expect(() => set('next friday')).toThrow(DomainError);
    expect(() => set('2099-13-01')).toThrow(DomainError);
    expect(() => logManualCall(db, { lead_id: lead, idempotency_key: key(), outcome_code: 'no_appt', appointment_for: '2099-10-30' })).toThrow(DomainError);
  });

  it('goes with an undo (and comes back in the answer), or when the outcome changes to something else', () => {
    const call = set('2099-10-30T14:00');
    expect(voidCall(db, call).appointment_for).toBe('2099-10-30T14:00');
    expect(currentAppointment(db, lead)).toBeNull();
    const again = set('2099-10-31T10:30');
    changeOutcome(db, again, { outcome_code: 'no_appt', expected_current_id: currentOutcome(db, again)!.id });
    expect(currentAppointment(db, lead)).toBeNull();
  });

  it('gives way to the Unitrust appointment once the extension sends one', () => {
    set('2099-10-30T14:00');
    const later = new Date(Date.now() + 1000).toISOString();
    db.prepare(
      "INSERT INTO appointment (id, lead_id, scheduled_for, recorded_via, created_at, unitrust_key) VALUES (?, ?, '2099-10-30T15:00', 'unitrust', ?, 'k1')",
    ).run(uuidv7(), lead, later);
    expect(currentAppointment(db, lead)).toEqual({ scheduled_for: '2099-10-30T15:00', source: 'unitrust' });
    // Lead status and counting still go by Unitrust and the calls, as before.
    expect((db.prepare('SELECT status FROM lead_state WHERE lead_id = ?').get(lead) as { status: string }).status).toBe('appointment_set');
  });
});

describe('appointments of a day (the Today page)', () => {
  it('lists the day\'s appointments earliest first, with the prep details and the last note', () => {
    db.prepare("UPDATE lead SET lender = 'Union Savings', loan_amount_cents = 18500000, tobacco_raw = 'No' WHERE id = ?").run(lead);
    logManualCall(db, { lead_id: lead, idempotency_key: key(), outcome_code: 'appointment', appointment_for: '2099-10-30T14:00', note: 'Wife on the loan too' });
    const other = (db.prepare("SELECT id FROM lead WHERE id != ? LIMIT 1").get(lead) as { id: string }).id;
    logManualCall(db, { lead_id: other, idempotency_key: key(), outcome_code: 'appointment', appointment_for: '2099-10-30' });
    logManualCall(db, { lead_id: other, idempotency_key: key(), outcome_code: 'appointment', appointment_for: '2099-10-31T09:00' });
    const day = appointmentsOnDay(db, '2099-10-30');
    expect(day.map((p) => [p.lead_id, p.scheduled_for, p.source])).toEqual([[other, '2099-10-30', 'app'], [lead, '2099-10-30T14:00', 'app']]);
    expect(day[1]).toMatchObject({ lender: 'Union Savings', loan_amount_cents: 18500000, tobacco_raw: 'No', last_note: 'Wife on the loan too' });
    expect(appointmentsOnDay(db, '2099-10-29')).toEqual([]);
  });

  it('leaves out undone ones, and a typed time once Unitrust sends the appointment', () => {
    const call = set('2099-10-30T14:00');
    voidCall(db, call);
    expect(appointmentsOnDay(db, '2099-10-30')).toEqual([]);
    set('2099-10-30T14:00');
    db.prepare(
      "INSERT INTO appointment (id, lead_id, scheduled_for, recorded_via, created_at, unitrust_key) VALUES (?, ?, '2099-10-30T15:00', 'unitrust', ?, 'k1')",
    ).run(uuidv7(), lead, new Date(Date.now() + 1000).toISOString());
    expect(appointmentsOnDay(db, '2099-10-30').map((p) => [p.scheduled_for, p.source])).toEqual([['2099-10-30T15:00', 'unitrust']]);
  });
});
