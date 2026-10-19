-- Date of birth (YYYY-MM-DD) and the value as it was on the lead page or sheet.
-- When a lead has one, its age is worked out from it.
ALTER TABLE lead ADD COLUMN dob TEXT;
ALTER TABLE lead ADD COLUMN dob_raw TEXT;
