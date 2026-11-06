-- The log of rule runs (rules themselves are the `rules` setting, shared/rules.ts): when each ran, why, how many
-- leads it matched, what each action changed, and the leads, so you can see what a rule did and when.
CREATE TABLE rule_run (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL,
  rule_name    TEXT NOT NULL,
  trigger      TEXT NOT NULL CHECK (trigger IN ('daily', 'call_saved', 'manual')),
  at           TEXT NOT NULL,
  matched      INTEGER NOT NULL,
  results_json TEXT NOT NULL,
  lead_ids_json TEXT NOT NULL,
  error        TEXT
);
CREATE INDEX rule_run_rule ON rule_run(rule_id, at);
CREATE INDEX rule_run_at ON rule_run(at);
