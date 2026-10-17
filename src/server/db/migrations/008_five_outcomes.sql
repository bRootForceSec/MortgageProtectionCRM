-- Five call outcomes: 1 No answer, 2 Talked no appt, 3 Appt set, 4 Bad number, 5 Callback.
-- Older outcomes are retired as buttons; calls that used them keep them in history.
INSERT INTO outcome_code (code, label, grp, hotkey, counts_as_human_contact, requires_callback_time, marks_dead, sort_order, introduced_at, lead_effect) VALUES
  ('no_appt', 'Talked, no appt', 'contact', '2', 1, 0, 0, 20, '2026-10-17T00:00:00.000Z', NULL);

UPDATE outcome_code SET active = 0, hotkey = NULL
  WHERE code IN ('vm_left', 'vm_no_msg', 'busy', 'not_interested', 'wrong_person', 'hung_up', 'picked_up', 'other', 'dnc_request');

UPDATE outcome_code SET label = 'No answer',  hotkey = '1', sort_order = 10 WHERE code = 'no_answer';
UPDATE outcome_code SET label = 'Appt set',   hotkey = '3', sort_order = 30 WHERE code = 'appointment';
UPDATE outcome_code SET label = 'Bad number', hotkey = '4', sort_order = 40 WHERE code = 'bad_number';
UPDATE outcome_code SET label = 'Callback',   hotkey = '5', sort_order = 50 WHERE code = 'callback';

-- "Wrong person" is now part of "Bad number", so it no longer counts as reaching the lead.
UPDATE outcome_code SET counts_as_human_contact = 0 WHERE code = 'wrong_person';

-- A callback can be for a day with no set time ("any time that day").
ALTER TABLE call_outcome ADD COLUMN callback_any_time INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lead_state ADD COLUMN due_any_time INTEGER NOT NULL DEFAULT 0;

-- Outcome keys you changed in Settings pointed at the old outcomes; start again from 1-5.
UPDATE app_setting SET value_json = json_remove(value_json, '$.shortcuts.outcomes') WHERE key = 'calling';
