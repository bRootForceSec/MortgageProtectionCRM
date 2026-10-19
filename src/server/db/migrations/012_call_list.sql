-- The call list: the leads you chose to call, in your order. You add them from Leads or an import;
-- nothing is added or moved on its own. A lead is "worked" once it has a call saved after it was added.
CREATE TABLE call_list_item (
  lead_id   TEXT PRIMARY KEY REFERENCES lead(id),
  position  REAL NOT NULL,
  added_at  TEXT NOT NULL
);
CREATE INDEX call_list_position ON call_list_item(position);
