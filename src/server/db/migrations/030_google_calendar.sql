-- Google Calendar: the event the CRM put on (or found on) your calendar for each lead's appointment, so a later sync
-- moves that event when the appointment moves instead of adding another. One per lead and calendar.
CREATE TABLE calendar_event (
  lead_id         TEXT NOT NULL REFERENCES lead(id),
  calendar_id     TEXT NOT NULL,
  google_event_id TEXT NOT NULL,
  -- The appointment time the event shows, in your time ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"), and its title.
  starts          TEXT NOT NULL,
  summary         TEXT NOT NULL,
  -- 'added' (the CRM made it) or 'found' (it was already on your calendar, so it's left as you wrote it).
  origin          TEXT NOT NULL CHECK (origin IN ('added', 'found')),
  synced_at       TEXT NOT NULL,
  PRIMARY KEY (lead_id, calendar_id)
);
