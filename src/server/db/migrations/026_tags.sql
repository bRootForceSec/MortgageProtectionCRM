-- Tags: your own labels on leads ("Spanish", "Spouse decides", "Friday list"). Any number per lead. Leads can be
-- filtered by tag on the Leads page and in routine steps, and the rules engine will add and take them off.
CREATE TABLE tag (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE lead_tag (
  lead_id  TEXT NOT NULL REFERENCES lead(id),
  tag_id   TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (lead_id, tag_id)
);
CREATE INDEX lead_tag_tag ON lead_tag(tag_id);
