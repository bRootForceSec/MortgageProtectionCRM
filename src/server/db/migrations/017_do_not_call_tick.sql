-- "Do not call" is a tick box next to the outcome, not an outcome of its own. You still pick what happened on the
-- call (usually Talked, no appt), and the tick sends the lead to the dead pile so it stays off the queue and call lists.
-- Undoing the call or changing its outcome without the tick takes the lead back out of the dead pile.
ALTER TABLE call_outcome ADD COLUMN do_not_call INTEGER NOT NULL DEFAULT 0;

-- Calls saved as the "Do not call" outcome become "Talked, no appt" with the tick. The old outcome stays in history.
-- The new record keeps the old one's time, so a restore you did afterwards still counts.
INSERT INTO call_outcome (id, call_id, outcome_code, entered_at, supersedes_id, callback_due_at, callback_any_time, note, do_not_call)
  SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-7' || substr(hex(randomblob(2)), 2) || '-' ||
               substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
         o.call_id, 'no_appt', o.entered_at, o.id, NULL, 0, o.note, 1
  FROM call_outcome o
  WHERE o.outcome_code = 'dnc_request' AND NOT EXISTS (SELECT 1 FROM call_outcome s WHERE s.supersedes_id = o.id);

-- Back to five outcome keys: 1 No answer, 2 Talked no appt, 3 Appt set, 4 Bad number, 5 Callback.
UPDATE outcome_code SET active = 0, hotkey = NULL WHERE code = 'dnc_request';
UPDATE outcome_code SET hotkey = '4', sort_order = 40 WHERE code = 'bad_number';
UPDATE outcome_code SET hotkey = '5', sort_order = 50 WHERE code = 'callback';

-- An outcome key you changed in Settings to 4 or 5 would now clash, so those go back to the default.
UPDATE app_setting SET value_json = json_set(value_json, '$.shortcuts.outcomes', json(
    (SELECT json_group_object(j.key, j.value) FROM json_each(value_json, '$.shortcuts.outcomes') j
      WHERE j.key <> 'dnc_request' AND (j.value IS NULL OR j.value NOT IN ('4', '5')))))
  WHERE key = 'calling' AND json_type(value_json, '$.shortcuts.outcomes') = 'object';
