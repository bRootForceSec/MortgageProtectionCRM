// The lead's log (table lead_event): what happened to a lead, when, and what did it. Tags so far; fields, buttons and
// counters will be logged here too. Conditions read it through formulas (has, added, times, before...).

export type LeadEventKind = 'tag_added' | 'tag_removed';

/** What made a change: you by hand, a rule, an import, the Unitrust extension, a button, or a shortcut's rule. */
export type LeadEventSource = 'you' | 'rule' | 'import' | 'unitrust' | 'button' | 'shortcut';

/** Who did it, as stored with each line. `id` names the rule (or button) when there is one. */
export interface EventBy {
  source: LeadEventSource;
  id?: string | null;
  /** Shown in the lead's history, like the rule's name. */
  name?: string | null;
  /** The call it belongs to (a button pressed when saving a call), so undoing the call can undo it. */
  call_id?: string | null;
}

export const BY_YOU: EventBy = { source: 'you' };

/** "by a rule (No-shows onto the list)" style words for the history. */
export function describeBy(source: string, name?: string | null): string {
  const what: Record<string, string> = { you: 'by you', rule: 'by a rule', import: 'by an import', unitrust: 'by Unitrust', button: 'by a button', shortcut: 'by a shortcut' };
  return `${what[source] ?? `by ${source}`}${name ? ` (${name})` : ''}`;
}
