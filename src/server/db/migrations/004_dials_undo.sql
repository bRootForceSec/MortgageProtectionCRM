-- Dial counter and undo.

-- How many times you dialed the lead for this one attempt (e.g. two dials back to back, no answer).
ALTER TABLE call ADD COLUMN dial_count INTEGER NOT NULL DEFAULT 1 CHECK (dial_count >= 1);

-- A call you undid. The row and its events stay as history; it no longer counts anywhere.
ALTER TABLE call ADD COLUMN voided_at TEXT;
ALTER TABLE call ADD COLUMN void_reason TEXT;
