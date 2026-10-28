-- Appointments read from the Unitrust calendar by the Firefox extension. Each event becomes an appointment
-- (recorded_via 'unitrust', keyed by its day and phone), and each change of its color adds a result row.
-- Yellow ("rescheduled or sat, no sale") is a new result, 'follow_up'. Both tables were unused until now;
-- they are rebuilt to allow the new values, keeping any rows.
CREATE TABLE appointment_new (
  id                         TEXT PRIMARY KEY,
  lead_id                    TEXT NOT NULL REFERENCES lead(id),
  scheduled_for              TEXT,
  time_zone                  TEXT,
  set_on_call_id             TEXT REFERENCES call(id),
  set_from_number_id         TEXT REFERENCES caller_number(id),
  recorded_via               TEXT NOT NULL CHECK (recorded_via IN ('in_app_on_call','manual','sheet_import','unitrust')),
  internal_status            TEXT NOT NULL DEFAULT 'scheduled' CHECK (internal_status IN ('scheduled','rescheduled','canceled')),
  official_status            TEXT,
  official_status_entered_at TEXT,
  notes                      TEXT,
  created_at                 TEXT NOT NULL,
  unitrust_key               TEXT,   -- day and phone of the Unitrust event, e.g. "2026-10-26|6147069261"
  title                      TEXT    -- the event's title in Unitrust
);
INSERT INTO appointment_new (id, lead_id, scheduled_for, time_zone, set_on_call_id, set_from_number_id, recorded_via, internal_status,
                             official_status, official_status_entered_at, notes, created_at)
  SELECT id, lead_id, scheduled_for, time_zone, set_on_call_id, set_from_number_id, recorded_via, internal_status,
         official_status, official_status_entered_at, notes, created_at FROM appointment;

-- APPEND-ONLY. The newest row per appointment is its current result.
CREATE TABLE appointment_result_new (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointment_new(id),
  result         TEXT NOT NULL CHECK (result IN ('sat_no_sale','sold','no_show','rescheduled','canceled','cleared','follow_up')),
  rescheduled_to TEXT REFERENCES appointment_new(id),
  note           TEXT,
  entered_at     TEXT NOT NULL
);
INSERT INTO appointment_result_new SELECT id, appointment_id, result, rescheduled_to, note, entered_at FROM appointment_result;

DROP TABLE appointment_result;
DROP TABLE appointment;
ALTER TABLE appointment_new RENAME TO appointment;
ALTER TABLE appointment_result_new RENAME TO appointment_result;
CREATE INDEX appointment_lead ON appointment(lead_id);
CREATE UNIQUE INDEX appointment_unitrust_key ON appointment(unitrust_key) WHERE unitrust_key IS NOT NULL;
CREATE INDEX appointment_result_appt ON appointment_result(appointment_id, entered_at);

-- How the lead's latest Unitrust appointment went ('not_set', 'sold', 'no_show', 'follow_up'), and whether that
-- result is what put the lead back to be called (a no-show or yellow newer than the last call).
ALTER TABLE lead_state ADD COLUMN appt_result TEXT;
ALTER TABLE lead_state ADD COLUMN appt_missed INTEGER NOT NULL DEFAULT 0;
