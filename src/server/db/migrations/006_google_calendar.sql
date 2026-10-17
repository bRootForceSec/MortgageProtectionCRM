-- Google Calendar: one row per appointment put on the calendar.
-- Working state (not history): the worker moves a row through its states. What it did is in calendar_sync_event.
--
-- states:
--   queued     the #MP event still has to be created on Google
--   waiting    the #MP event is on the calendar; waiting for Unitrust to replace it with its own event
--   noted      your note is on top of Unitrust's event (still watched until the appointment time, in case Unitrust rewrites it)
--   done       nothing left to do
--   cancel     the call was undone; the #MP event has to be deleted
--   canceled   the #MP event was deleted (or never sent)
--   failed     Google refused the event for good (last_error says why)
CREATE TABLE calendar_sync (
  appointment_id      TEXT PRIMARY KEY REFERENCES appointment(id),
  lead_id             TEXT NOT NULL REFERENCES lead(id),
  source_lead_id      TEXT NOT NULL,        -- the LEAD ID Unitrust matches on
  title               TEXT NOT NULL,        -- #MP <lead id> <LAST NAME>
  starts_at           TEXT NOT NULL,        -- appointment time when the event was made (UTC)
  note                TEXT,                 -- what goes on top of Unitrust's event
  state               TEXT NOT NULL CHECK (state IN ('queued','waiting','noted','done','cancel','canceled','failed')),
  our_event_id        TEXT NOT NULL,        -- id we give the #MP event, so a retry never makes a second one
  our_event_created_at TEXT,
  unitrust_event_id   TEXT,
  unitrust_url        TEXT,                 -- the App_Management link from Unitrust's event
  unitrust_start      TEXT,                 -- start time on Unitrust's event (UTC)
  unitrust_found_at   TEXT,
  note_applied_at     TEXT,
  reapply_count       INTEGER NOT NULL DEFAULT 0,
  unitrust_left_after_cancel INTEGER NOT NULL DEFAULT 0,  -- the call was undone but Unitrust already has the appointment
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX calendar_sync_state ON calendar_sync(state);
CREATE INDEX calendar_sync_lead ON calendar_sync(lead_id);
CREATE INDEX calendar_sync_source ON calendar_sync(source_lead_id);

-- APPEND-ONLY. Everything the app did on your calendar, for the lead's history and for troubleshooting.
CREATE TABLE calendar_sync_event (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointment(id),
  at             TEXT NOT NULL,
  kind           TEXT NOT NULL,   -- created, found_unitrust, note_added, note_readded, deleted, error, gave_up, ...
  detail         TEXT
);
CREATE INDEX calendar_sync_event_appt ON calendar_sync_event(appointment_id, at);
