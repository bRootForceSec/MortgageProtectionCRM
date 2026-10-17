-- PDF import, county groups, lead types and prices, more phone numbers, history from a sheet's status column.

-- Lead types and their prices. Editable in Settings; seeded from the IMO flier at agent level 70.
-- The price in effect at import is copied onto each lead, so later price changes don't rewrite history.
CREATE TABLE lead_type (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  price_cents INTEGER,
  sort_order  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);
INSERT INTO lead_type (code, label, price_cents, sort_order, updated_at) VALUES
  ('FE-A',  'FE-A (final expense, 0-30 days)',     2900, 10,  '2026-10-17T00:00:00.000Z'),
  ('CI-A',  'CI-A (call-in, 0-14 days)',           3400, 20,  '2026-10-17T00:00:00.000Z'),
  ('DM-A',  'DM-A (direct mail, 0-21 days)',       7900, 30,  '2026-10-17T00:00:00.000Z'),
  ('CI-AA', 'CI-AA (call-in, 15-44 days)',         1100, 40,  '2026-10-17T00:00:00.000Z'),
  ('DM-AA', 'DM-AA (direct mail, 22-44 days)',     1300, 50,  '2026-10-17T00:00:00.000Z'),
  ('CI-A1', 'CI-A1 (call-in aborted, 0-45 days)',   600, 60,  '2026-10-17T00:00:00.000Z'),
  ('B',     'B (45 days-9 months)',                 700, 70,  '2026-10-17T00:00:00.000Z'),
  ('C',     'C (10-18 months)',                     400, 80,  '2026-10-17T00:00:00.000Z'),
  ('D',     'D (A1-CI 45 days-12 months, CI/DM 19-36 months)', 100, 90, '2026-10-17T00:00:00.000Z'),
  ('E',     'E (37-60 months)',                      75, 100, '2026-10-17T00:00:00.000Z');

-- New lead columns. Existing leads keep NULLs.
ALTER TABLE lead ADD COLUMN phone3_raw TEXT;
ALTER TABLE lead ADD COLUMN phone3_e164 TEXT;
ALTER TABLE lead ADD COLUMN county TEXT;          -- display name, e.g. "St. Joseph"
ALTER TABLE lead ADD COLUMN county_key TEXT;      -- "IN|ST JOSEPH"
ALTER TABLE lead ADD COLUMN county_source TEXT;   -- page | zip | city | manual
ALTER TABLE lead ADD COLUMN lead_type TEXT;       -- lead_type.code
ALTER TABLE lead ADD COLUMN price_cents INTEGER;  -- what this lead cost
ALTER TABLE lead ADD COLUMN source_lead_id TEXT;  -- e.g. the Mortgage Identification Number
ALTER TABLE lead ADD COLUMN callin_at TEXT;       -- call-in date as printed, read as local time of the lead's state
ALTER TABLE lead ADD COLUMN callin_raw TEXT;
ALTER TABLE lead ADD COLUMN source_page INTEGER;  -- PDF page the lead came from
CREATE INDEX lead_county ON lead(county_key);
CREATE INDEX lead_source_id ON lead(source_lead_id);

-- APPEND-ONLY. Later edits to lead details (type, county, name, phones...). The lead row holds the current value.
CREATE TABLE lead_change (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES lead(id),
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX lead_change_lead ON lead_change(lead_id, created_at);

-- Which area codes each county is called under. Chosen by you; a county can have several.
CREATE TABLE county_area_code (
  county_key TEXT NOT NULL,
  area_code  TEXT NOT NULL CHECK (length(area_code) = 3),
  created_at TEXT NOT NULL,
  PRIMARY KEY (county_key, area_code)
);

-- Calls recreated from a spreadsheet's status column: no real time is known.
ALTER TABLE call ADD COLUMN history_source TEXT;            -- NULL for calls logged in the app; 'sheet' for imported history
ALTER TABLE call ADD COLUMN time_known INTEGER NOT NULL DEFAULT 1;

-- What an outcome does to the lead beyond its group (e.g. 'sold' takes it out of the queue).
ALTER TABLE outcome_code ADD COLUMN lead_effect TEXT;
INSERT INTO outcome_code (code, label, grp, hotkey, counts_as_human_contact, requires_callback_time, marks_dead, sort_order, introduced_at, lead_effect) VALUES
  ('picked_up',   'Picked up',                   'contact', NULL, 1, 0, 0, 120, '2026-10-17T00:00:00.000Z', NULL),
  ('sat_no_sale', 'Appointment sat, no sale',    'contact', NULL, 1, 0, 0, 130, '2026-10-17T00:00:00.000Z', NULL),
  ('sold',        'Sold',                        'contact', NULL, 1, 0, 0, 140, '2026-10-17T00:00:00.000Z', 'sold');

-- Appointments imported from a sheet have no date. Rebuild the table to allow that (nothing references it).
CREATE TABLE appointment_new (
  id                         TEXT PRIMARY KEY,
  lead_id                    TEXT NOT NULL REFERENCES lead(id),
  scheduled_for              TEXT,
  time_zone                  TEXT,
  set_on_call_id             TEXT REFERENCES call(id),
  set_from_number_id         TEXT REFERENCES caller_number(id),
  recorded_via               TEXT NOT NULL CHECK (recorded_via IN ('in_app_on_call','manual','sheet_import')),
  internal_status            TEXT NOT NULL DEFAULT 'scheduled' CHECK (internal_status IN ('scheduled','rescheduled','canceled')),
  official_status            TEXT,
  official_status_entered_at TEXT,
  notes                      TEXT,
  created_at                 TEXT NOT NULL
);
INSERT INTO appointment_new SELECT * FROM appointment;
DROP TABLE appointment;
ALTER TABLE appointment_new RENAME TO appointment;
CREATE INDEX appointment_lead ON appointment(lead_id);

-- Resumable imports. Working state, not history: rows move into import_row/lead when the import is committed.
CREATE TABLE import_draft (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('pdf','sheet')),
  file_name     TEXT NOT NULL,
  file_sha256   TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  file_modified TEXT,
  status        TEXT NOT NULL CHECK (status IN ('reading','review','committed','deleted')),
  settings_json TEXT NOT NULL,   -- sheet name, column mapping, default lead type, batch details
  progress_json TEXT,            -- pages read so far, errors
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  batch_id      TEXT REFERENCES import_batch(id)
);

CREATE TABLE import_draft_row (
  draft_id      TEXT NOT NULL REFERENCES import_draft(id),
  row_number    INTEGER NOT NULL,      -- sheet row, or PDF page
  page          INTEGER,
  fields_json   TEXT NOT NULL,         -- field key -> value as read
  edits_json    TEXT,                  -- field key -> value you entered in review
  issues_json   TEXT,                  -- [{field, message, blocking}]
  notes         TEXT,                  -- what the reader or AI said about this row
  extractor     TEXT,                  -- text | ai:<provider>:<model> | sheet | pending
  review        TEXT NOT NULL CHECK (review IN ('auto','needs_review','ok','discarded')),
  lead_type     TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (draft_id, row_number)
);

-- Non-secret settings (AI provider and model, defaults). API keys are kept in a separate 0600 file, never here.
CREATE TABLE app_setting (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
