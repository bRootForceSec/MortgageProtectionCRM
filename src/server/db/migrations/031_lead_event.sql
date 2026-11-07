-- The lead's log: each tag put on or taken off a lead, when, and what did it (you, a rule, an import...). Lines are
-- never changed. lead_tag holds the tags a lead has now and is kept in step with this log in the same transaction.
-- Formulas read the log (has, added, times, before...: domain/formulas.ts), so a yes/no formula field is a condition
-- over a lead's history. More of a lead's changes (fields, buttons, counters) will be logged here; `kind` and
-- `source` are kept to the values in src/shared/leadEvents.ts by the code.
CREATE TABLE lead_event (
  id        TEXT PRIMARY KEY,
  lead_id   TEXT NOT NULL REFERENCES lead(id),
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  -- No foreign key: a deleted tag's history stays. Conditions find tags by their name now, so they skip it.
  tag_id    TEXT,
  -- The tag's name when it happened, so the history reads right after a rename or delete.
  tag_name  TEXT,
  source    TEXT NOT NULL,
  -- Which rule (or, later, button) did it, and its name then.
  source_id TEXT,
  source_name TEXT,
  call_id   TEXT
);
CREATE INDEX lead_event_lead ON lead_event(lead_id, kind, tag_id, at);

-- Tag history so far was in lead_change (field "tag"): move it here.
INSERT INTO lead_event (id, lead_id, at, kind, tag_id, tag_name, source)
SELECT c.id, c.lead_id, c.created_at,
       CASE WHEN c.new_value IS NOT NULL THEN 'tag_added' ELSE 'tag_removed' END,
       (SELECT t.id FROM tag t WHERE t.name = coalesce(c.new_value, c.old_value)),
       coalesce(c.new_value, c.old_value), 'you'
FROM lead_change c WHERE c.field = 'tag';

-- A tag on a lead with no line saying it was added (a renamed tag's older lines name it differently): one now.
INSERT INTO lead_event (id, lead_id, at, kind, tag_id, tag_name, source)
SELECT lower(hex(randomblob(16))), x.lead_id, x.added_at, 'tag_added', x.tag_id, t.name, 'you'
FROM lead_tag x JOIN tag t ON t.id = x.tag_id
WHERE NOT EXISTS (SELECT 1 FROM lead_event e WHERE e.lead_id = x.lead_id AND e.tag_id = x.tag_id AND e.kind = 'tag_added');

DELETE FROM lead_change WHERE field = 'tag';
