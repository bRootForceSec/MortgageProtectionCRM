-- Custom fields: fields you add to every lead ("Spouse's name", "Mortgage payment", "Smoker?"), edited on the lead.
-- Values are kept as text in a fixed form for their type (shared/customFields.ts); a lead with no value has no row.
CREATE TABLE custom_field (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type         TEXT NOT NULL CHECK (type IN ('text', 'number', 'money', 'date', 'yes_no', 'choice')),
  options_json TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE lead_custom_value (
  lead_id    TEXT NOT NULL REFERENCES lead(id),
  field_id   TEXT NOT NULL REFERENCES custom_field(id) ON DELETE CASCADE,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (lead_id, field_id)
);
CREATE INDEX lead_custom_value_field ON lead_custom_value(field_id, value);
