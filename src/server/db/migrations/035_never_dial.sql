-- A tag can be marked "never dial" (Settings → Tags): a lead with it is left off the call list, unless you add it
-- anyway, and the Calling screen asks before dialing it. Each "add anyway" and each confirmed dial is a line in the
-- lead's log (lead_event, kind never_dial_override).
ALTER TABLE tag ADD COLUMN never_dial INTEGER NOT NULL DEFAULT 0;
