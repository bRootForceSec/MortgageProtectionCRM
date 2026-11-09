-- A rule's steps after a wait (Automation → Rules: "Wait 2h, then..."): each lead the rule reached waits here until
-- due_at, then the rule runner does the rule's steps from next_step on (up to the next wait). A row goes once its steps
-- are done, or when its rule is gone or switched off.
CREATE TABLE rule_wait (
  id         TEXT PRIMARY KEY,
  rule_id    TEXT NOT NULL,
  lead_id    TEXT NOT NULL REFERENCES lead(id),
  next_step  INTEGER NOT NULL,
  due_at     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX rule_wait_due ON rule_wait(due_at);
