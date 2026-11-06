import * as z from 'zod/v4';
import { LeadQuery } from './leadFilter.js';
import { WEEKDAYS } from './routines.js';

// Rules: "when this happens, for leads like these, do that". Set up in Settings → Rules, or from the Leads filters.
// A rule has one trigger, a Leads filter (kept as its query, so "yesterday" means yesterday every day) and its actions.
// Every run is logged, and Preview shows what a run would do now without changing anything.

export const RuleTrigger = z.discriminatedUnion('kind', [
  /** Once a day, at or after this time on this computer, on these weekdays (0 is Sunday). */
  z.object({
    kind: z.literal('daily'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 08:00'),
    days: z.array(z.number().int().min(0).max(6)).min(1, 'pick at least one day').max(7),
  }),
  /** When a call is saved for a lead, with one of these outcomes (any outcome when empty). */
  z.object({ kind: z.literal('call_saved'), outcomes: z.array(z.string().max(40)).max(40) }),
  /** Only when you press Run now. */
  z.object({ kind: z.literal('manual') }),
]);
export type RuleTrigger = z.infer<typeof RuleTrigger>;

const tagName = z.string().trim().min(1, 'name the tag').max(40);

export const RuleAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_to_list') }),
  z.object({ kind: z.literal('remove_from_list') }),
  z.object({ kind: z.literal('add_tag'), tag: tagName }),
  z.object({ kind: z.literal('remove_tag'), tag: tagName }),
  /** Sets one of your fields; a blank value clears it. */
  z.object({ kind: z.literal('set_field'), field_id: z.string().min(1).max(64), value: z.string().max(2000) }),
  z.object({ kind: z.literal('mark_dead'), reason: z.string().max(200).optional() }),
]);
export type RuleAction = z.infer<typeof RuleAction>;

export const Rule = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'give the rule a name').max(80),
  enabled: z.boolean(),
  trigger: RuleTrigger,
  /** Which leads it acts on: the Leads filters. */
  filter: LeadQuery.partial(),
  actions: z.array(RuleAction).min(1, 'give the rule something to do').max(10),
});
export type Rule = z.infer<typeof Rule>;

export const Rules = z.array(Rule).max(100);

export const ACTION_LABELS: Record<RuleAction['kind'], string> = {
  add_to_list: 'Add to the call list',
  remove_from_list: 'Take off the call list',
  add_tag: 'Add a tag',
  remove_tag: 'Take a tag off',
  set_field: 'Set one of your fields',
  mark_dead: 'Put in the dead pile',
};

export const TRIGGER_LABELS: Record<RuleTrigger['kind'], string> = {
  daily: 'Every day at a time',
  call_saved: 'When a call is saved',
  manual: 'Only when I press Run now',
};

/** "Mon–Fri" style list of weekdays. */
export function describeDays(days: readonly number[]): string {
  const set = [...new Set(days)].sort();
  if (set.length === 7) return 'every day';
  if (set.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (set.join() === '0,6') return 'weekends';
  return set.map((d) => WEEKDAYS[d]).join(', ');
}

/** The trigger in words. `outcomeLabel` turns an outcome code into its name. */
export function describeTrigger(t: RuleTrigger, outcomeLabel: (code: string) => string = (c) => c): string {
  if (t.kind === 'daily') return `At ${t.time} ${t.days.length < 7 ? `on ${describeDays(t.days)}` : 'every day'}`;
  if (t.kind === 'call_saved') return t.outcomes.length ? `When a call is saved as ${t.outcomes.map(outcomeLabel).join(' or ')}` : 'When any call is saved';
  return 'Only when you press Run now';
}

/** An action in words. `fieldName` turns a field id into its name. */
export function describeAction(a: RuleAction, fieldName: (id: string) => string | undefined = () => undefined): string {
  switch (a.kind) {
    case 'add_tag': return `Tag "${a.tag}"`;
    case 'remove_tag': return `Take tag "${a.tag}" off`;
    case 'set_field': return a.value.trim() ? `Set ${fieldName(a.field_id) ?? 'a deleted field'} to "${a.value}"` : `Clear ${fieldName(a.field_id) ?? 'a deleted field'}`;
    case 'mark_dead': return `Put in the dead pile${a.reason ? ` ("${a.reason}")` : ''}`;
    default: return ACTION_LABELS[a.kind];
  }
}

/** Ready-made rules: the no-show example you gave. They start switched off; switch them on in Settings → Rules. */
export const STARTER_RULES: readonly Omit<Rule, 'id'>[] = [
  {
    name: "Yesterday's no-shows onto the call list",
    enabled: false,
    trigger: { kind: 'daily', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] },
    filter: { status: 'appt_no_show', appt_days_ago: 1 },
    actions: [{ kind: 'add_to_list' }],
  },
  {
    name: 'No-shows from 2 days ago off the call list',
    enabled: false,
    trigger: { kind: 'daily', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] },
    filter: { status: 'appt_no_show', appt_days_ago: 2, on_list: '1' },
    actions: [{ kind: 'remove_from_list' }],
  },
];

/** What one action did (or would do) in a run. */
export interface ActionResult {
  action: RuleAction;
  /** Leads it changed (or would change). Leads it already fit, or that can't take it, are not counted. */
  changed: number;
  /** Why some leads were left alone, e.g. "3 booked, bad or dead". */
  note: string | null;
}

/** One run of a rule, as the log keeps it (and Preview returns, with dry_run). */
export interface RuleRun {
  id: string;
  rule_id: string;
  rule_name: string;
  trigger: 'daily' | 'call_saved' | 'manual';
  at: string;
  dry_run: boolean;
  matched: number;
  results: ActionResult[];
  /** Up to 50 of the leads it matched, with names, for the log. */
  leads: { id: string; name: string }[];
  error: string | null;
}
