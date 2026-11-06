-- Formula fields: a custom field worked out from the lead (shared/formula.ts), like a lead score.
-- custom_field gains the 'formula' kind and its formula. The kind list is a CHECK, so the table is made again; the
-- values are set aside first, because dropping custom_field would delete them (ON DELETE CASCADE).
CREATE TABLE lead_custom_value_keep AS SELECT * FROM lead_custom_value;
DROP TABLE lead_custom_value;

CREATE TABLE custom_field_new (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type         TEXT NOT NULL CHECK (type IN ('text', 'number', 'money', 'date', 'yes_no', 'choice', 'formula')),
  options_json TEXT,
  formula      TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
INSERT INTO custom_field_new (id, label, type, options_json, sort_order, created_at)
  SELECT id, label, type, options_json, sort_order, created_at FROM custom_field;
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

-- Every lead's value in every field, typed and worked out alike. The server makes this view again whenever a formula
-- changes (domain/formulas.ts); filters, sorting, rules and the export read it.
CREATE VIEW lead_field_value AS SELECT lead_id, field_id, value FROM lead_custom_value;
