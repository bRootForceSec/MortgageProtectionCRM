-- A field can show on the lead and the Calling screen only while a condition is true for the lead (show_when), and be
-- needed while another is (required_when): Settings → Your fields. Null means always shown, never needed.
ALTER TABLE custom_field ADD COLUMN show_when TEXT;
ALTER TABLE custom_field ADD COLUMN required_when TEXT;
