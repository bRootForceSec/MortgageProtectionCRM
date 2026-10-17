-- Appointments are tracked in Unitrust, not here. "Appointment set" stays as a call outcome with no date or time.
--  * The Google Calendar connection was taken out: drop its tables (it only ever held working state).
--  * "Appointment sat, no sale" and "Sold" are retired as outcomes (older calls keep them; they count as booked).
-- The appointment and appointment_result tables are kept, unused, so nothing you entered is lost.
DROP TABLE IF EXISTS calendar_sync_event;
DROP TABLE IF EXISTS calendar_sync;
UPDATE outcome_code SET active = 0 WHERE code IN ('sat_no_sale', 'sold');
DELETE FROM app_setting WHERE key = 'google_calendar';
