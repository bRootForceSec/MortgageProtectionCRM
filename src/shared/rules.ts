import * as z from 'zod/v4';
import { LeadQuery } from './leadFilter.js';
import { WEEKDAYS } from './routines.js';
import { isStep, SUGGESTED_FOLLOW_UPS } from './followUps.js';

// Rules: "when this happens, for leads like these, do that". Set up in Automation → Rules, or from the Leads filters.
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
  /** When this tag is put on a lead (by anything: you, a button, a rule, an import). Acts on that lead. */
  z.object({ kind: z.literal('tag_added'), tag: z.string().trim().min(1, 'name the tag').max(40) }),
  /** When this tag is taken off a lead. */
  z.object({ kind: z.literal('tag_removed'), tag: z.string().trim().min(1, 'name the tag').max(40) }),
  /** When a lead comes into one of your statuses, or leaves it. */
  z.object({ kind: z.literal('status'), status_id: z.string().min(1).max(64), when: z.enum(['enters', 'leaves']) }),
  /**
   * When this condition turns true for a lead (it's checked after each change and every minute). With `already`, the
   * leads it's already true for when the rule is saved count too.
   */
  z.object({ kind: z.literal('becomes_true'), condition: z.string().trim().min(1, 'write the condition').max(2000), already: z.boolean().optional() }),
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
  /** Changes a counter (one of your fields of the kind Counter): add a number (a negative one takes off), or set it (0 resets). */
  z.object({ kind: z.literal('counter'), field_id: z.string().min(1).max(64), op: z.enum(['add', 'set']), by: z.number().int().min(-1_000_000).max(1_000_000) }),
  /**
   * Makes the lead come back: each step ("15m", "2h", "3d", "1d@09:00") is a callback, timed from now and then from each
   * try nobody answered. An answer, a callback or any other outcome ends it; a newer one replaces it.
   */
  z.object({ kind: z.literal('come_back'), steps: z.array(z.string().trim().toLowerCase().refine(isStep, 'write each step like 15m, 2h, 3d or 1d@09:00')).min(1, 'give it a step, like 1d@09:00').max(10) }),
]);
export type RuleAction = z.infer<typeof RuleAction>;

/** A rule a tag shortcut made (shortcuts below): shown with its shortcut, changed only by changing the shortcut. */
export const MadeBy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('expiry'), tag_id: z.string() }),
  z.object({ kind: z.literal('group'), group_id: z.string(), name: z.string() }),
]);
export type MadeBy = z.infer<typeof MadeBy>;

export const Rule = z.object({
  id: z.string().min(1).max(120),
  made_by: MadeBy.optional(),
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
  counter: 'Change a counter',
  come_back: 'Make it come back',
};

export const TRIGGER_LABELS: Record<RuleTrigger['kind'], string> = {
  daily: 'Every day at a time',
  call_saved: 'When a call is saved',
  manual: 'Only when I press Run now',
  tag_added: 'When a tag is put on',
  tag_removed: 'When a tag is taken off',
  status: 'When a lead enters or leaves a status',
  becomes_true: 'When a condition turns true',
};

/** Triggers that fire for a lead when something about it changes, so they act on that lead only. */
export const LEAD_TRIGGERS: readonly RuleTrigger['kind'][] = ['call_saved', 'tag_added', 'tag_removed', 'status', 'becomes_true'];

/** "Mon–Fri" style list of weekdays. */
export function describeDays(days: readonly number[]): string {
  const set = [...new Set(days)].sort();
  if (set.length === 7) return 'every day';
  if (set.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (set.join() === '0,6') return 'weekends';
  return set.map((d) => WEEKDAYS[d]).join(', ');
}

/** The trigger in words. `outcomeLabel` turns an outcome code into its name, `statusName` a status id into its. */
export function describeTrigger(
  t: RuleTrigger,
  outcomeLabel: (code: string) => string = (c) => c,
  statusName: (id: string) => string | undefined = () => undefined,
): string {
  switch (t.kind) {
    case 'daily': return `At ${t.time} ${t.days.length < 7 ? `on ${describeDays(t.days)}` : 'every day'}`;
    case 'call_saved': return t.outcomes.length ? `When a call is saved as ${t.outcomes.map(outcomeLabel).join(' or ')}` : 'When any call is saved';
    case 'tag_added': return `When tag "${t.tag}" is put on a lead`;
    case 'tag_removed': return `When tag "${t.tag}" is taken off a lead`;
    case 'status': {
      const name = statusName(t.status_id);
      return name ? `When a lead ${t.when === 'enters' ? 'comes into' : 'leaves'} the status "${name}"` : 'When a lead enters or leaves a status that was deleted';
    }
    case 'becomes_true': return `When this turns true for a lead: ${t.condition}`;
    case 'manual': return 'Only when you press Run now';
  }
}

/** An action in words. `fieldName` turns a field id into its name. */
export function describeAction(a: RuleAction, fieldName: (id: string) => string | undefined = () => undefined): string {
  switch (a.kind) {
    case 'add_tag': return `Tag "${a.tag}"`;
    case 'remove_tag': return `Take tag "${a.tag}" off`;
    case 'set_field': return a.value.trim() ? `Set ${fieldName(a.field_id) ?? 'a deleted field'} to "${a.value}"` : `Clear ${fieldName(a.field_id) ?? 'a deleted field'}`;
    case 'mark_dead': return `Put in the dead pile${a.reason ? ` ("${a.reason}")` : ''}`;
    case 'counter': {
      const name = fieldName(a.field_id) ?? 'a deleted counter';
      if (a.op === 'set') return a.by === 0 ? `Reset ${name} to 0` : `Set ${name} to ${a.by}`;
      return a.by < 0 ? `Take ${-a.by} off ${name}` : `Add ${a.by} to ${name}`;
    }
    case 'come_back': return `Come back after ${a.steps.join(', then ')}`;
    default: return ACTION_LABELS[a.kind];
  }
}

/** Ready-made rules: the no-show example you gave. They start switched off; switch them on in Automation → Rules. */
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
  // The follow-up plans (Settings → Calling) as rules you can see and change: the same steps, set off by the result.
  ...([['no_show', 'No-shows'], ['sat_no_sale', 'Picked up, no presentation'], ['prezi', 'Presentation, no sale']] as const).map(([result, who]) => ({
    name: `${who}: come back ${SUGGESTED_FOLLOW_UPS[result].join(', then ')}`,
    enabled: false,
    trigger: { kind: 'becomes_true' as const, condition: `appt_result == "${result}"` },
    filter: {},
    actions: [{ kind: 'come_back' as const, steps: [...SUGGESTED_FOLLOW_UPS[result]] }],
  })),
];

// Tag shortcuts (Automation → Tags): each one is only a way to write rules, and shows the rules it writes.
// - Take a tag off by itself: after so many hours, or at the end of the day it was put on.
// - Only one at a time: a group of tags where putting one on takes the others off.

export const TagExpiry = z.object({
  tag_id: z.string().min(1).max(64),
  /** Hours after it was put on; null takes it off at the end of that day. */
  hours: z.number().int().min(1, 'at least 1 hour').max(24 * 365).nullable(),
});
export type TagExpiry = z.infer<typeof TagExpiry>;

export const TagGroup = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'name the group').max(60),
  /** A rule has at most 10 actions, and putting one on takes off each of the others. */
  tag_ids: z.array(z.string().min(1).max(64)).min(2, 'a group needs two tags or more').max(11, 'a group can have 11 tags at most'),
});
export type TagGroup = z.infer<typeof TagGroup>;

export const TagShortcuts = z.object({ expiry: z.array(TagExpiry).max(500), groups: z.array(TagGroup).max(100) });
export type TagShortcuts = z.infer<typeof TagShortcuts>;

/** "after 24 hours" / "at the end of the day". */
export function describeExpiry(hours: number | null): string {
  if (hours == null) return 'at the end of the day it was put on';
  if (hours % 24 === 0) return `${hours / 24} day${hours === 24 ? '' : 's'} after it was put on`;
  return `${hours} hour${hours === 1 ? '' : 's'} after it was put on`;
}

/** Python text for a tag's name in a condition. */
const pyName = (s: string) => JSON.stringify(s);

/** The rules your shortcuts write, with your tags' names now. A shortcut on a deleted tag writes nothing. */
export function shortcutRules(sc: TagShortcuts, tagName: (id: string) => string | undefined): Rule[] {
  const out: Rule[] = [];
  for (const x of sc.expiry) {
    const name = tagName(x.tag_id);
    if (!name) continue;
    const since = x.hours == null ? `days_since(added(${pyName(name)})) >= 1` : `hours_since(added(${pyName(name)})) >= ${x.hours}`;
    out.push({
      id: `expiry:${x.tag_id}`, made_by: { kind: 'expiry', tag_id: x.tag_id }, name: `Take "${name}" off ${describeExpiry(x.hours)}`.slice(0, 80), enabled: true,
      trigger: { kind: 'becomes_true', condition: `has(${pyName(name)}) and ${since}`, already: true }, filter: {}, actions: [{ kind: 'remove_tag', tag: name }],
    });
  }
  for (const g of sc.groups) {
    const names = g.tag_ids.map(tagName).filter((n): n is string => !!n);
    if (names.length < 2) continue;
    for (const name of names) {
      out.push({
        id: `group:${g.id}:${name.toLowerCase()}`, made_by: { kind: 'group', group_id: g.id, name: g.name }, name: `${g.name}: "${name}" takes the others off`.slice(0, 80), enabled: true,
        trigger: { kind: 'tag_added', tag: name }, filter: {}, actions: names.filter((o) => o !== name).map((o) => ({ kind: 'remove_tag' as const, tag: o })),
      });
    }
  }
  return out;
}

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
  trigger: RuleTrigger['kind'];
  at: string;
  dry_run: boolean;
  matched: number;
  results: ActionResult[];
  /** Up to 50 of the leads it matched, with names, for the log. */
  leads: { id: string; name: string }[];
  error: string | null;
}
