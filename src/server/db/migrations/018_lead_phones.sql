-- A lead can have any number of phone numbers. The main number stays on the lead (phone_raw, phone_e164);
-- every other number is a row here, in the order shown, with what it is ("Alternate", "Called in from", or a
-- label you typed). The two fixed extra slots (phone2, phone3) move here and are dropped from the lead.
CREATE TABLE lead_other_phone (
  lead_id TEXT NOT NULL REFERENCES lead(id),
  pos     INTEGER NOT NULL,
  raw     TEXT,
  e164    TEXT,
  label   TEXT,
  PRIMARY KEY (lead_id, pos)
);
CREATE INDEX lead_other_phone_e164 ON lead_other_phone(e164);

INSERT INTO lead_other_phone (lead_id, pos, raw, e164, label)
  SELECT id, 1, phone2_raw, phone2_e164, 'Alternate' FROM lead WHERE phone2_raw IS NOT NULL OR phone2_e164 IS NOT NULL;
INSERT INTO lead_other_phone (lead_id, pos, raw, e164, label)
  SELECT id, CASE WHEN phone2_raw IS NOT NULL OR phone2_e164 IS NOT NULL THEN 2 ELSE 1 END, phone3_raw, phone3_e164, 'Called in from'
  FROM lead WHERE phone3_raw IS NOT NULL OR phone3_e164 IS NOT NULL;

DROP INDEX IF EXISTS lead_phone2;
DROP INDEX IF EXISTS lead_phone3;
ALTER TABLE lead DROP COLUMN phone2_raw;
ALTER TABLE lead DROP COLUMN phone2_e164;
ALTER TABLE lead DROP COLUMN phone3_raw;
ALTER TABLE lead DROP COLUMN phone3_e164;

-- Every number of every lead (main and others), for finding the leads that have a number.
CREATE VIEW lead_number AS
  SELECT id lead_id, phone_e164 e164 FROM lead WHERE phone_e164 IS NOT NULL
  UNION ALL
  SELECT lead_id, e164 FROM lead_other_phone WHERE e164 IS NOT NULL;
