// A link to one lead, to paste into an appointment in Unitrust or a calendar. Clicking it opens the lead in the CRM:
// the server's /lead/<id> page brings the desktop app's window up on that lead, or, in a browser (the Linux
// service), sends you on to the app at #lead/<id>. The Unitrust extension reads the same link to match an event
// to its lead (extension/unitrust/calendar.js has a copy of the pattern, since it can't import this file).

const LEAD_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IN_TEXT = new RegExp(`(?:/lead/|#lead/)(${LEAD_ID})\\b`, 'i');

/** The link to a lead on the server at `origin` (for example http://127.0.0.1:5170). */
export function leadLink(origin: string, leadId: string): string {
  return `${origin}/lead/${leadId}`;
}

/** Whether `s` looks like a lead id. */
export function isLeadId(s: string): boolean {
  return new RegExp(`^${LEAD_ID}$`, 'i').test(s);
}

/** The lead a link in some text points to (a pasted /lead/<id> link, or the page's #lead/<id>), or null. */
export function leadIdInText(text: string | null | undefined): string | null {
  const m = IN_TEXT.exec(text ?? '');
  return m ? m[1]!.toLowerCase() : null;
}
