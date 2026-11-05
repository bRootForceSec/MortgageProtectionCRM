import { describe, it, expect, beforeEach } from 'vitest';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall, voidCall } from '../../src/server/domain/calls.js';
import { appointmentsOnDay } from '../../src/server/domain/appointments.js';
import { appointmentCounts, appointmentsOnDays } from '../../src/server/domain/unitrustAppointments.js';
import { DomainError } from '../../src/server/core/errors.js';
import type { DB } from '../../src/server/db/connection.js';
import { uuidv7 } from '../../src/server/ids.js';

// On-the-spot appointments: Appt set and run on the same call ("Run it now"), counted apart from ones booked ahead.

let db: DB;
let spot: string;
let ahead: string;
const key = () => `k-${uuidv7()}`;
const pad = (n: number) => String(n).padStart(2, '0');
const d = new Date();
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowWall = `${today}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

beforeEach(async () => {
  ({ db } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  const ids = (db.prepare('SELECT id FROM lead ORDER BY created_at').all() as { id: string }[]).map((r) => r.id);
  [spot, ahead] = ids as [string, string];
});

const call = (lead_id: string, outcome_code: string, extra: Record<string, unknown> = {}) =>
  logManualCall(db, { lead_id, idempotency_key: key(), outcome_code, ...extra }).call_id;

describe('on-the-spot appointments', () => {
  it('counts an appointment run on the same call apart from one booked ahead', () => {
    call(spot, 'appointment', { appointment_for: nowWall, on_the_spot: true });
    call(spot, 'appt_sale');
    call(ahead, 'appointment');
    call(ahead, 'appt_prezi');

    const rows = appointmentsOnDays(db, today, today);
    expect(rows.find((r) => r.lead_id === spot)).toMatchObject({ on_the_spot: true, outcome: 'sold' });
    expect(rows.find((r) => r.lead_id === ahead)).toMatchObject({ on_the_spot: false, outcome: 'prezi' });
    const onSpot = appointmentCounts(rows.filter((r) => r.on_the_spot));
    expect(onSpot).toMatchObject({ appointments: 1, sat: 1, sold: 1, close_rate: 1 });
  });

  it('is not an appointment to prepare for or be alerted about on Today', () => {
    call(spot, 'appointment', { appointment_for: nowWall, on_the_spot: true });
    call(ahead, 'appointment', { appointment_for: `${today}T23:59` });
    expect(appointmentsOnDay(db, today).map((c) => c.lead_id)).toEqual([ahead]);
  });

  it('needs its time, and only an appointment set takes one', () => {
    expect(() => call(spot, 'appointment', { on_the_spot: true })).toThrow(DomainError);
    expect(() => call(spot, 'no_appt', { appointment_for: nowWall, on_the_spot: true })).toThrow(DomainError);
  });

  it('stops being on the spot when the Appt set is undone', () => {
    const set = call(spot, 'appointment', { appointment_for: nowWall, on_the_spot: true });
    call(spot, 'appt_sale');
    voidCall(db, set);
    expect(appointmentsOnDays(db, today, today).find((r) => r.lead_id === spot)?.on_the_spot).toBe(false);
  });
});
