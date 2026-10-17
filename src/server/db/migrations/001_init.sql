-- Phase 1 schema.
-- Conventions: ids are UUIDv7 text; timestamps are UTC ISO-8601 text with milliseconds;
-- money is integer cents. SQL is kept close to standard so it can move to Postgres later.
-- Tables marked APPEND-ONLY must never have rows updated, except processing columns.

-- Lead purchase batches (one per imported file, or per purchase).
CREATE TABLE import_batch (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'opt_lead_manager',
  file_name           TEXT,
  file_sha256         TEXT,
  imported_at         TEXT NOT NULL,
  purchased_count     INTEGER,
  cost_total_cents    INTEGER,
  cost_per_lead_cents INTEGER,
  lead_type           TEXT,
  lead_age_label      TEXT,
  column_mapping_json TEXT NOT NULL,
  notes               TEXT
);
CREATE INDEX import_batch_sha ON import_batch(file_sha256);

-- APPEND-ONLY. Every row of every imported file, accepted or not.
CREATE TABLE import_row (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES import_batch(id),
  row_number      INTEGER NOT NULL,
  raw_json        TEXT NOT NULL,
  row_fingerprint TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('accepted','duplicate_in_file','already_imported','rejected')),
  errors_json     TEXT,
  warnings_json   TEXT,
  lead_id         TEXT
);
CREATE INDEX import_row_batch ON import_row(batch_id);
CREATE INDEX import_row_fp ON import_row(row_fingerprint);

-- One lead per accepted source row. Raw source values are kept next to normalized ones.
CREATE TABLE lead (
  id                  TEXT PRIMARY KEY,
  batch_id            TEXT NOT NULL REFERENCES import_batch(id),
  import_row_id       TEXT NOT NULL REFERENCES import_row(id),
  first_name          TEXT,
  last_name           TEXT,
  full_name_raw       TEXT,
  phone_raw           TEXT,
  phone_e164          TEXT,
  phone_valid         INTEGER NOT NULL DEFAULT 0,
  phone2_raw          TEXT,
  phone2_e164         TEXT,
  email               TEXT,
  lender              TEXT,
  loan_amount_cents   INTEGER,
  loan_amount_raw     TEXT,
  age                 INTEGER,
  age_raw             TEXT,
  coborrower_raw      TEXT,
  coborrower_signal   TEXT NOT NULL DEFAULT 'unknown' CHECK (coborrower_signal IN ('yes','unknown')),
  address_line        TEXT,
  city                TEXT,
  state               TEXT,
  zip                 TEXT,
  time_zone           TEXT,
  tobacco_raw         TEXT,
  health_heart_raw    TEXT,
  health_stroke_raw   TEXT,
  health_cancer_raw   TEXT,
  health_diabetes_raw TEXT,
  extra_json          TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX lead_phone ON lead(phone_e164);
CREATE INDEX lead_batch ON lead(batch_id);

-- Suggested duplicate pairs. Duplicates are linked, never merged or deleted.
CREATE TABLE lead_link (
  id          TEXT PRIMARY KEY,
  lead_a      TEXT NOT NULL REFERENCES lead(id),
  lead_b      TEXT NOT NULL REFERENCES lead(id),
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','same_person','different_person')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (lead_a, lead_b, reason)
);

-- Caller-ID numbers you own (basic in Phase 1, managed fully in Phase 3).
CREATE TABLE caller_number (
  id                    TEXT PRIMARY KEY,
  e164                  TEXT NOT NULL UNIQUE,
  label                 TEXT,
  provider              TEXT NOT NULL DEFAULT 'manual',
  provider_number_id    TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','standby','retired')),
  acquired_at           TEXT,
  retired_at            TEXT,
  retire_reason         TEXT,
  reputation_status     TEXT NOT NULL DEFAULT 'unchecked' CHECK (reputation_status IN ('unchecked','clear','flagged','investigating')),
  reputation_updated_at TEXT,
  notes                 TEXT,
  created_at            TEXT NOT NULL
);

-- One row per call attempt. Never merged. Lifecycle columns are derived from call_event.
CREATE TABLE call (
  id                   TEXT PRIMARY KEY,
  lead_id              TEXT REFERENCES lead(id),
  direction            TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  channel              TEXT NOT NULL CHECK (channel IN ('manual_log','telnyx')),
  from_number_id       TEXT REFERENCES caller_number(id),
  from_e164            TEXT,
  to_e164              TEXT NOT NULL,
  requested_at         TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL UNIQUE,
  initiation_result    TEXT NOT NULL DEFAULT 'accepted',
  provider             TEXT,
  provider_session_id  TEXT,
  provider_refs_json   TEXT,
  -- derived
  state                TEXT NOT NULL DEFAULT 'requested',
  state_confirmed_by   TEXT,
  started_at           TEXT,
  answered_at          TEXT,
  ended_at             TEXT,
  ring_seconds         INTEGER,
  talk_seconds         INTEGER,
  hangup_cause         TEXT,
  billed_seconds       INTEGER,
  cost_micros          INTEGER,
  derived_at           TEXT
);
CREATE INDEX call_lead ON call(lead_id, requested_at);
CREATE INDEX call_requested ON call(requested_at);

-- APPEND-ONLY raw history of everything that happened to a call.
CREATE TABLE call_event (
  id                TEXT PRIMARY KEY,
  call_id           TEXT REFERENCES call(id),
  source            TEXT NOT NULL CHECK (source IN ('provider_webhook','client_sdk','server','manual','reconciliation')),
  provider          TEXT,
  provider_event_id TEXT,
  dedup_key         TEXT NOT NULL UNIQUE,
  event_type_raw    TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  occurred_at       TEXT NOT NULL,
  received_at       TEXT NOT NULL,
  signature_ok      INTEGER,
  payload_json      TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'applied' CHECK (processing_status IN ('pending','applied','unmatched','error')),
  processing_error  TEXT
);
CREATE INDEX call_event_call ON call_event(call_id, occurred_at);

-- Outcome vocabulary. Data, not code, so it can evolve without migrations.
CREATE TABLE outcome_code (
  code                    TEXT PRIMARY KEY,
  label                   TEXT NOT NULL,
  grp                     TEXT NOT NULL CHECK (grp IN ('no_contact','contact','invalid','dead')),
  hotkey                  TEXT,
  counts_as_human_contact INTEGER NOT NULL,
  requires_callback_time  INTEGER NOT NULL DEFAULT 0,
  marks_dead              INTEGER NOT NULL DEFAULT 0,
  sort_order              INTEGER NOT NULL,
  active                  INTEGER NOT NULL DEFAULT 1,
  introduced_at           TEXT NOT NULL,
  retired_at              TEXT
);

-- APPEND-ONLY. Your interpretation of a call. Latest non-superseded row is current.
CREATE TABLE call_outcome (
  id              TEXT PRIMARY KEY,
  call_id         TEXT NOT NULL REFERENCES call(id),
  outcome_code    TEXT NOT NULL REFERENCES outcome_code(code),
  entered_at      TEXT NOT NULL,
  supersedes_id   TEXT REFERENCES call_outcome(id),
  callback_due_at TEXT,
  note            TEXT
);
CREATE INDEX call_outcome_call ON call_outcome(call_id, entered_at);
CREATE UNIQUE INDEX call_outcome_supersedes ON call_outcome(supersedes_id) WHERE supersedes_id IS NOT NULL;

-- APPEND-ONLY notes. An edit is a new note pointing at the old one.
CREATE TABLE note (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL REFERENCES lead(id),
  call_id       TEXT REFERENCES call(id),
  body          TEXT NOT NULL,
  replaces_id   TEXT REFERENCES note(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX note_lead ON note(lead_id, created_at);

-- APPEND-ONLY manual lead-level decisions (skip, move to dead pile, restore).
CREATE TABLE lead_action (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES lead(id),
  action     TEXT NOT NULL CHECK (action IN ('skip','mark_dead','restore')),
  reason     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX lead_action_lead ON lead_action(lead_id, created_at);

-- Own appointment records. Never the official status (that lives on the IMO site).
CREATE TABLE appointment (
  id                         TEXT PRIMARY KEY,
  lead_id                    TEXT NOT NULL REFERENCES lead(id),
  scheduled_for              TEXT NOT NULL,
  time_zone                  TEXT,
  set_on_call_id             TEXT REFERENCES call(id),
  set_from_number_id         TEXT REFERENCES caller_number(id),
  recorded_via               TEXT NOT NULL CHECK (recorded_via IN ('in_app_on_call','manual')),
  internal_status            TEXT NOT NULL DEFAULT 'scheduled' CHECK (internal_status IN ('scheduled','rescheduled','canceled')),
  official_status            TEXT,
  official_status_entered_at TEXT,
  notes                      TEXT,
  created_at                 TEXT NOT NULL
);
CREATE INDEX appointment_lead ON appointment(lead_id);

-- Derived, rebuildable projection: one row per lead.
CREATE TABLE lead_state (
  lead_id             TEXT PRIMARY KEY REFERENCES lead(id),
  status              TEXT NOT NULL,
  attempts_total      INTEGER NOT NULL,
  last_call_at        TEXT,
  last_outcome_code   TEXT,
  next_due_at         TEXT,
  skipped_at          TEXT,
  preferred_number_id TEXT,
  derived_at          TEXT NOT NULL
);
CREATE INDEX lead_state_status ON lead_state(status, next_due_at);

-- Edits to editable records.
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id     TEXT NOT NULL,
  action     TEXT NOT NULL,
  old_json   TEXT,
  new_json   TEXT
);

-- Saved column mappings per source, so the next import of the same layout is one click.
CREATE TABLE saved_mapping (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  header_key   TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
