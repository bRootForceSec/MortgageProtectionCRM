-- Yellow on the Unitrust calendar is now split: 'rescheduled' (the event moved to a later day; still to come) or
-- 'sat_no_sale' (it stayed on its day). Yellows stored so far as 'follow_up' are split the same way, by whether the
-- appointment's day was after the day the yellow was first seen.
UPDATE appointment_result
SET result = CASE
  WHEN substr((SELECT a.scheduled_for FROM appointment a WHERE a.id = appointment_result.appointment_id), 1, 10) > substr(entered_at, 1, 10)
    THEN 'rescheduled' ELSE 'sat_no_sale' END
WHERE result = 'follow_up';
-- Their leads are rebuilt when the app starts (it rebuilds lead_state on every start).
