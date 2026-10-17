-- Appointment results and caller ID reputation checks.

-- APPEND-ONLY. How an appointment went, in your own words for your numbers (the IMO site stays the official record).
-- The newest row for an appointment is its current result; a correction is a new row.
CREATE TABLE appointment_result (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointment(id),
  result         TEXT NOT NULL CHECK (result IN ('sat_no_sale','sold','no_show','rescheduled','canceled','cleared')),
  rescheduled_to TEXT REFERENCES appointment(id),  -- the new appointment, for 'rescheduled'
  note           TEXT,
  entered_at     TEXT NOT NULL
);
CREATE INDEX appointment_result_appt ON appointment_result(appointment_id, entered_at);

-- APPEND-ONLY. Reputation checks you did by hand for a caller ID number. The newest row per item is current.
CREATE TABLE caller_number_check (
  id         TEXT PRIMARY KEY,
  number_id  TEXT NOT NULL REFERENCES caller_number(id),
  item       TEXT NOT NULL,
  checked_on TEXT,                 -- the date you did it (YYYY-MM-DD); NULL clears the item
  result     TEXT CHECK (result IN ('ok','problem')),
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX caller_number_check_number ON caller_number_check(number_id, item, created_at);
