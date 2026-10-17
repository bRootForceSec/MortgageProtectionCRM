-- A lead now calls its first number that isn't ruled out. A bad number rules out the number that was dialed,
-- and other leads with the same number share "bad number" and "dead pile".
ALTER TABLE lead_state ADD COLUMN active_phone_e164 TEXT;
ALTER TABLE lead_state ADD COLUMN blocked_phones_json TEXT;
ALTER TABLE lead_state ADD COLUMN block_reason TEXT;
CREATE INDEX IF NOT EXISTS lead_phone2 ON lead(phone2_e164);
CREATE INDEX IF NOT EXISTS lead_phone3 ON lead(phone3_e164);
CREATE INDEX IF NOT EXISTS call_to ON call(to_e164);

-- Counties on Central time in states that are mostly Eastern. Same list as COUNTY_TZ in normalize.ts.
UPDATE lead SET time_zone = 'America/Chicago' WHERE county_key IN (
  'IN|LAKE', 'IN|PORTER', 'IN|LAPORTE', 'IN|LA PORTE', 'IN|NEWTON', 'IN|JASPER', 'IN|STARKE',
  'IN|GIBSON', 'IN|POSEY', 'IN|VANDERBURGH', 'IN|WARRICK', 'IN|SPENCER', 'IN|PERRY');
UPDATE lead SET time_zone = 'America/Menominee' WHERE county_key IN ('MI|GOGEBIC', 'MI|IRON', 'MI|DICKINSON', 'MI|MENOMINEE');
