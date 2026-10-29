-- Appointment calls: the Calling screen has two sides, First call and Appointment. Each outcome belongs to one side,
-- and keys 1-5 mean the outcomes of the side that is showing.
ALTER TABLE outcome_code ADD COLUMN kind TEXT NOT NULL DEFAULT 'first_call' CHECK (kind IN ('first_call','appointment'));

-- How an appointment call went. "Sat, no sale": picked up, no presentation. "Prezi": presented and lost them.
-- No show, sat and prezi put the lead back to be called; sale and rescheduled keep it out of the queue.
INSERT INTO outcome_code (code, label, grp, hotkey, counts_as_human_contact, requires_callback_time, marks_dead, sort_order, introduced_at, lead_effect, kind) VALUES
  ('appt_no_show',     'No show',      'no_contact', '1', 0, 0, 0, 110, '2026-10-29T00:00:00.000Z', NULL, 'appointment'),
  ('appt_sat_no_sale', 'Sat, no sale', 'contact',    '2', 1, 0, 0, 120, '2026-10-29T00:00:00.000Z', NULL, 'appointment'),
  ('appt_prezi',       'Prezi',        'contact',    '3', 1, 0, 0, 130, '2026-10-29T00:00:00.000Z', NULL, 'appointment'),
  ('appt_sale',        'Sale',         'contact',    '4', 1, 0, 0, 140, '2026-10-29T00:00:00.000Z', 'sold', 'appointment'),
  ('appt_rescheduled', 'Rescheduled',  'contact',    '5', 1, 0, 0, 150, '2026-10-29T00:00:00.000Z', NULL, 'appointment');

-- Why a lead said no, for each call. Nothing on screen asks for these yet: they are here for when calls are
-- transcribed, and for a picker later.
CREATE TABLE objection_code (
  code       TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1
);
INSERT INTO objection_code (code, label, sort_order) VALUES
  ('price',           'Price',           10),
  ('spouse',          'Spouse',          20),
  ('already_covered', 'Already covered', 30),
  ('think_about_it',  'Think about it',  40),
  ('health',          'Health',          50),
  ('trust',           'Trust',           60),
  ('other',           'Other',           70);

-- APPEND-ONLY. One row per objection heard on a call. `source` says who noted it: you, or later a transcript.
CREATE TABLE call_objection (
  id             TEXT PRIMARY KEY,
  call_id        TEXT NOT NULL REFERENCES call(id),
  objection_code TEXT NOT NULL REFERENCES objection_code(code),
  note           TEXT,
  source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','transcript')),
  created_at     TEXT NOT NULL
);
CREATE INDEX call_objection_call ON call_objection(call_id);
