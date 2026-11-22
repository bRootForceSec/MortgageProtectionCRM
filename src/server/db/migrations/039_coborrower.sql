-- The co-borrower as a person on the same lead: name, date of birth (YYYY-MM-DD, with the value as printed),
-- age (worked out from the date of birth when there is one) and gender. coborrower_raw stays what the page or
-- sheet said ("Yes", "No" or a name).
ALTER TABLE lead ADD COLUMN coborrower_name TEXT;
ALTER TABLE lead ADD COLUMN coborrower_dob TEXT;
ALTER TABLE lead ADD COLUMN coborrower_dob_raw TEXT;
ALTER TABLE lead ADD COLUMN coborrower_age INTEGER;
ALTER TABLE lead ADD COLUMN coborrower_gender TEXT;

-- A name already in the co-borrower column is the co-borrower's name, and means there is one.
UPDATE lead SET coborrower_name = trim(coborrower_raw), coborrower_signal = 'yes'
WHERE coborrower_raw GLOB '*[A-Za-z][A-Za-z]*'
  AND lower(trim(coborrower_raw)) NOT IN ('yes', 'no', 'true', 'false', 'none', 'unknown', 'checked', 'unchecked', 'n/a', 'na');
