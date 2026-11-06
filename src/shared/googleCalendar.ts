import * as z from 'zod/v4';

// Google Calendar: the CRM puts each lead's appointment on your Google Calendar as "#MP <Lead ID> <Last name>", unless
// it's there already, and moves it when the appointment moves. Shapes shared by the server and Settings.

export const GoogleCalendarSettings = z.object({
  /** Put appointments on the calendar. Off: nothing is sent to Google. */
  enabled: z.boolean(),
  /** Which calendar ("primary" is your main one). */
  calendar_id: z.string().min(1).max(300),
  /** How long an appointment's event is, in minutes. */
  duration_min: z.number().int().min(5).max(480),
});
export type GoogleCalendarSettings = z.infer<typeof GoogleCalendarSettings>;

export const DEFAULT_GOOGLE_CALENDAR: GoogleCalendarSettings = { enabled: true, calendar_id: 'primary', duration_min: 60 };

/** What one sync did. */
export interface CalendarSyncResult {
  at: string;
  /** Upcoming appointments looked at. */
  checked: number;
  /** Events added, moved, and found already on the calendar (left as they were). */
  added: number;
  moved: number;
  found: number;
  error: string | null;
}

export interface GoogleCalendarStatus {
  /** Your Google key (OAuth client) is saved. */
  has_client: boolean;
  /** Signed in to Google. */
  connected: boolean;
  /** The Google account, once known. */
  account: string | null;
  settings: GoogleCalendarSettings;
  last_sync: CalendarSyncResult | null;
  /** The address Google sends you back to after signing in: it goes in the OAuth client. */
  redirect_uri: string;
}
