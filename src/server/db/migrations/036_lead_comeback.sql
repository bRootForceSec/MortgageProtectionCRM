-- When a rule makes a lead come back: a plan of steps ("15m", "1d@09:00", "3d"), each a callback timed from when it
-- was set and then from each try nobody answered, like a follow-up plan. Any other outcome since ends it. lead_state
-- reads the latest one.
CREATE TABLE lead_comeback (
  id        TEXT PRIMARY KEY,
  lead_id   TEXT NOT NULL REFERENCES lead(id),
  set_at    TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  rule_id   TEXT,
  rule_name TEXT
);
CREATE INDEX lead_comeback_lead ON lead_comeback(lead_id, set_at);
