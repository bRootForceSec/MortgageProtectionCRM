// A lead's phone numbers other than the main one, as the server sends them and the UI shows them.

export interface OtherPhone {
  /** As imported or typed. */
  raw: string | null;
  /** Null when the number isn't a valid US number. */
  e164: string | null;
  /** What the number is: "Alternate", "Called in from", or what you typed. */
  label: string | null;
}
