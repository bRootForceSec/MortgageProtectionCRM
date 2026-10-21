-- "Do not call" is back as outcome 4: a good number, but the person asked not to be called again.
-- It counts as reaching the lead (a pickup and a contact) and sends the lead to the dead pile, so it stays off
-- the queue and call lists. Bad number moves to 5 and Callback to 6.
UPDATE outcome_code SET label = 'Do not call', active = 1, hotkey = '4', sort_order = 40,
       grp = 'dead', counts_as_human_contact = 1, marks_dead = 1
  WHERE code = 'dnc_request';
UPDATE outcome_code SET hotkey = '5', sort_order = 50 WHERE code = 'bad_number';
UPDATE outcome_code SET hotkey = '6', sort_order = 60 WHERE code = 'callback';

-- An outcome key you changed in Settings to 4, 5 or 6 would now clash, so those go back to the default.
UPDATE app_setting SET value_json = json_set(value_json, '$.shortcuts.outcomes', json(
    (SELECT json_group_object(j.key, j.value) FROM json_each(value_json, '$.shortcuts.outcomes') j
      WHERE j.value IS NULL OR j.value NOT IN ('4', '5', '6'))))
  WHERE key = 'calling' AND json_type(value_json, '$.shortcuts.outcomes') = 'object';
