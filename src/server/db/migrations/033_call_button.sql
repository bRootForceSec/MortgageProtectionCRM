-- The button a call was saved with (Settings → Buttons, domain/buttons.ts), and its name then, so an older call keeps
-- its button after you rename or delete it. Null for calls from before buttons, and after an edit of the outcome: the
-- outcome's own button.
ALTER TABLE call_outcome ADD COLUMN button_id TEXT;
ALTER TABLE call_outcome ADD COLUMN button_label TEXT;
