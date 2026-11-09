import * as z from 'zod/v4';
import { STATUS_COLORS } from './statuses.js';
import { OUTCOMES, outcomeDef, type OutcomeCode } from './outcomes.js';
import type { CallMode } from './appointments.js';

// The buttons on the Calling screen, from your setup (setting `buttons`, domain/buttons.ts). Each button saves the call
// as one outcome (what it counts as: a pickup, an appt set...), and can show only when a condition is true, have its
// own look, and add or take off tags. Every active outcome has its own button (its id is the outcome's code), whose
// name and "shown" are the outcome's (Settings, the `outcome_overrides` setting). You can add more buttons that count
// as any outcome, like "Left voicemail" counting as No answer. A call keeps the button it was saved with.

export const BUTTON_COLORS = ['default', ...STATUS_COLORS] as const;
export type ButtonColor = (typeof BUTTON_COLORS)[number];
export const BUTTON_FILLS = ['outline', 'filled'] as const;
export const BUTTON_BORDERS = ['solid', 'dotted', 'dashed'] as const;

const tagIds = z.array(z.string().min(1).max(64)).max(10).default([]);

/** A button as you edit it in Settings. */
export const ButtonDef = z.object({
  id: z.string().min(1).max(64),
  /** The outcome the call is saved as. */
  outcome: z.string().min(1).max(64),
  label: z.string().trim().min(1, 'give the button a name').max(40, 'keep the name under 40 characters'),
  /** No button on the Calling screen; it still works for older calls. */
  hidden: z.boolean().default(false),
  /** A condition (Python syntax); blank means always. */
  show_when: z.string().trim().max(2000).default(''),
  color: z.enum(BUTTON_COLORS).default('default'),
  fill: z.enum(BUTTON_FILLS).default('outline'),
  border: z.enum(BUTTON_BORDERS).default('solid'),
  /** Asks "are you sure?" before it does anything. */
  confirm: z.boolean().default(false),
  /** Shown when you hover over it. */
  tooltip: z.string().trim().max(200).default(''),
  /**
   * Tags the lead with the button's name when pressed, taking off the tag of the last button pressed that did the same,
   * so has("No answer") means the last call went that way and times("No answer") counts every one.
   */
  tag_self: z.boolean().default(true),
  add_tags: tagIds,
  remove_tags: tagIds,
  /** Your fields it asks for before it saves (by id), filled in on the Calling screen and saved with the call. */
  asks: z.array(z.string().min(1).max(64)).max(5).default([]),
});
export type ButtonDef = z.infer<typeof ButtonDef>;
export const ButtonDefs = z.array(ButtonDef).max(100);

/** A button as the UI gets it: with its side of the Calling screen, and whether it's an outcome's own. */
export interface ButtonInfo extends ButtonDef {
  side: CallMode;
  /** The outcome's own button: it can't be deleted, only hidden, and its name is the outcome's name. */
  own: boolean;
  /** Its key until you change it (Keyboard shortcuts). */
  default_key: string | null;
}

/** Every active outcome's own button, in the outcomes' order, before you change anything. */
/** The smart list the appointment buttons show for (made once, when the First call and Appointment sides went). */
export const APPOINTMENT_LIST = 'Has an appointment';

/** When an outcome's own button shows to start with: the appointment ones for leads with an appointment, the rest for the others. */
export function starterShowWhen(outcome: string): string {
  return buttonSide({ outcome }) === 'appointment' ? `in_list("${APPOINTMENT_LIST}")` : `not in_list("${APPOINTMENT_LIST}")`;
}

export function starterButtons(label: (code: OutcomeCode) => string, offered: (code: OutcomeCode) => boolean): ButtonDef[] {
  return (Object.entries(OUTCOMES) as [OutcomeCode, (typeof OUTCOMES)[OutcomeCode]][])
    .filter(([, o]) => o.active)
    .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
    .map(([code]) => ButtonDef.parse({ id: code, outcome: code, label: label(code), hidden: !offered(code), show_when: starterShowWhen(code) }));
}

/** The button's side, from its outcome. */
export function buttonSide(b: { outcome: string }): CallMode {
  return outcomeDef(b.outcome)?.kind ?? 'first_call';
}

/** "Adds Hot, takes off Cold" style words for what a button does to tags. */
export function describeButtonTags(b: Pick<ButtonDef, 'add_tags' | 'remove_tags'>, tagName: (id: string) => string | undefined): string {
  const names = (ids: string[]) => ids.map((id) => tagName(id) ?? 'a deleted tag').join(', ');
  return [b.add_tags.length && `adds ${names(b.add_tags)}`, b.remove_tags.length && `takes off ${names(b.remove_tags)}`].filter(Boolean).join(', ');
}

/** The CSS classes for a button's look. */
export function buttonClass(b: Pick<ButtonDef, 'color' | 'fill' | 'border'>): string {
  return [b.color !== 'default' && `c-${b.color}`, b.fill === 'filled' && b.color !== 'default' && 'filled', b.border !== 'solid' && `b-${b.border}`]
    .filter(Boolean)
    .join(' ');
}
