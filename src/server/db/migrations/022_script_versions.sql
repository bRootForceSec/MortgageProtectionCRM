-- Script versions: each opener you've used, kept so every call can say which one was on screen. Later, with
-- transcripts, openers can be compared by pickup-to-appointment rate. A version is never changed or deleted.
CREATE TABLE script_version (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('opener')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX script_version_body ON script_version(kind, body);

-- The opener in Settings when a call was logged live on the Calling page. NULL for older calls, calls entered for
-- an earlier time, and calls made with no opener written.
ALTER TABLE call ADD COLUMN script_version_id TEXT REFERENCES script_version(id);
