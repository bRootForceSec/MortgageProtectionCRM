-- Saved call lists: a call list you put away to come back to later. Loading one makes it the call list
-- again (it leaves the saved lists), keeping each lead's added time so leads you already worked stay worked.
CREATE TABLE saved_call_list (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  saved_at  TEXT NOT NULL
);
CREATE TABLE saved_call_list_item (
  list_id   TEXT NOT NULL REFERENCES saved_call_list(id) ON DELETE CASCADE,
  lead_id   TEXT NOT NULL REFERENCES lead(id),
  position  REAL NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (list_id, lead_id)
);
-- The name of the list being called, when it came from a saved list (so saving it again offers the same name).
CREATE TABLE call_list_meta (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  name  TEXT
);
