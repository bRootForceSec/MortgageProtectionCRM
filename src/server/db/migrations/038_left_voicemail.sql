-- "Left voicemail" on the Calling screen: you left a message on this call. A fact of the call, beside its outcome.
ALTER TABLE call ADD COLUMN left_voicemail INTEGER NOT NULL DEFAULT 0;
