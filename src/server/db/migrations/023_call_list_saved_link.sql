-- Saved lists become copies you can save over and load again (loading no longer takes a list off the saved
-- lists). The call list remembers which saved list it is, so Save can update it in place.
ALTER TABLE call_list_meta ADD COLUMN saved_list_id TEXT REFERENCES saved_call_list(id) ON DELETE SET NULL;
