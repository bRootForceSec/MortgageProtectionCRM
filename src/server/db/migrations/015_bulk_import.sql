-- Bulk import: many lead files (or a whole folder) in one go. Each file still becomes its own draft and batch;
-- these tables only track the run and what happened to each file.
CREATE TABLE import_bulk (
  id            TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,   -- lead type, add to call list, import complete leads now
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE import_bulk_file (
  bulk_id       TEXT NOT NULL REFERENCES import_bulk(id),
  seq           INTEGER NOT NULL,
  file_name     TEXT NOT NULL,
  rel_path      TEXT,            -- where it was in the folder you picked
  part          TEXT,            -- "2 of 5" when a big spreadsheet is imported in parts
  size_bytes    INTEGER,
  file_sha256   TEXT,
  state         TEXT NOT NULL CHECK (state IN ('queued','reading','needs_columns','needs_review','imported','nothing_new','failed','removed')),
  draft_id      TEXT REFERENCES import_draft(id),     -- the draft (or the part of it put aside to check)
  batch_id      TEXT REFERENCES import_batch(id),     -- the leads imported from it
  message       TEXT,
  summary_json  TEXT,            -- counts: imported, repeats, not imported, to check
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (bulk_id, seq)
);
CREATE INDEX import_bulk_file_draft ON import_bulk_file(draft_id);
CREATE INDEX import_bulk_file_sha ON import_bulk_file(file_sha256);
