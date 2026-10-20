-- "They called me back": a mark you set (one key on the Calling screen) when a lead returns your call.
CREATE TABLE lead_called_back (
  lead_id  TEXT PRIMARY KEY REFERENCES lead(id),
  at       TEXT NOT NULL
);
