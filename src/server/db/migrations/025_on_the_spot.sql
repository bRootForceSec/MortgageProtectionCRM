-- On-the-spot appointments: an appointment set and run on the same call ("Run it now" on the Calling screen).
-- Marked on the appointment row typed on Appt set, so Reports can count onspots apart from appointments booked ahead.
ALTER TABLE appointment ADD COLUMN on_the_spot INTEGER NOT NULL DEFAULT 0;
