-- Rules, second version (shared/rules.ts).
-- 1. custom_field gains the 'counter' kind: a number on a lead that only rules change. The kind list is a CHECK, so
--    the table is made again, as in 029: the values are set aside first, because dropping custom_field would delete
--    them (ON DELETE CASCADE). The view over the values goes first and the server makes it again when it opens.
DROP VIEW IF EXISTS lead_field_value;
CREATE TABLE lead_custom_value_keep AS SELECT * FROM lead_custom_value;
DROP TABLE lead_custom_value;

CREATE TABLE custom_field_new (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type         TEXT NOT NULL CHECK (type IN ('text', 'number', 'money', 'date', 'yes_no', 'choice', 'formula', 'counter')),
  options_json TEXT,
  formula      TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
INSERT INTO custom_field_new (id, label, type, options_json, formula, sort_order, created_at)
  SELECT id, label, type, options_json, formula, sort_order, created_at FROM custom_field;
DROP TABLE custom_field;
ALTER TABLE custom_field_new RENAME TO custom_field;

CREATE TABLE lead_custom_value (
  lead_id    TEXT NOT NULL REFERENCES lead(id),
  field_id   TEXT NOT NULL REFERENCES custom_field(id) ON DELETE CASCADE,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (lead_id, field_id)
);
INSERT INTO lead_custom_value SELECT * FROM lead_custom_value_keep;
DROP TABLE lead_custom_value_keep;
CREATE INDEX lead_custom_value_field ON lead_custom_value(field_id, value);
CREATE VIEW lead_field_value AS SELECT lead_id, field_id, value FROM lead_custom_value;

-- 2. The rule log takes the new triggers, and runs a loop stopped. Its trigger list was a CHECK, so it's made again
--    with none: the code keeps it to RuleTrigger's kinds.
CREATE TABLE rule_run_new (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL,
  rule_name    TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  at           TEXT NOT NULL,
  matched      INTEGER NOT NULL,
  results_json TEXT NOT NULL,
  lead_ids_json TEXT NOT NULL,
  error        TEXT
);
INSERT INTO rule_run_new SELECT * FROM rule_run;
DROP TABLE rule_run;
ALTER TABLE rule_run_new RENAME TO rule_run;
CREATE INDEX rule_run_rule ON rule_run(rule_id, at);
CREATE INDEX rule_run_at ON rule_run(at);

-- 3. For a rule that fires when a lead enters or leaves a status, or a condition turns true: the leads it was true
--    for at the last check, so the next check sees who came in or went out.
CREATE TABLE rule_watch (
  rule_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  PRIMARY KEY (rule_id, lead_id)
) WITHOUT ROWID;
