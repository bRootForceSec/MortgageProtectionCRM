-- Editing and deleting notes (lead page and Calling screen). Notes stay append-only: an edit is a new note whose
-- replaces_id points at the old one (it keeps the old one's created_at, and edited_at says when), and a delete marks
-- the current version deleted_at, like an undone call. The old text stays in the table and in audit_log.
ALTER TABLE note ADD COLUMN edited_at TEXT;
ALTER TABLE note ADD COLUMN deleted_at TEXT;
