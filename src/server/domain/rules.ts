import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { DomainError } from '../core/errors.js';
import { nowIso, uuidv7 } from '../ids.js';
import { LEAD_NAME } from '../db/sql.js';
import { LeadQuery } from '../../shared/leadFilter.js';
import { normalizeCustomValue } from '../../shared/customFields.js';
import { Rules, TagShortcuts, shortcutRules, type ActionResult, type Rule, type RuleAction, type RuleRun, type RuleTrigger } from '../../shared/rules.js';
import { addToCallList, matchingLeadIds, removeFromCallList, toLeadFilter, WORKED } from './callList.js';
import { ensureTag, neverDialOf, setTagOnLeads, tagByName } from './tags.js';
import { listCustomFields, setCustomValues } from './customFields.js';
import { addLeadAction, setComeback } from './calls.js';
import { callableIds } from './callable.js';
import { conditionSql, loadStatusDefs } from './formulas.js';
import { afterStep } from '../../shared/followUps.js';

// Rules (shared/rules.ts): stored as one setting, run by their trigger, every run written to rule_run.
// A run finds the leads matching the rule's filter now, then does each action to them in order, in one transaction:
// if any action fails, nothing changes and the log says why. Preview does the same and then undoes it.
// Rules on a lead's changes (a tag put on or taken off, a status entered or left, a condition turning true) run from
// runEventRules after each change and every minute, on just the leads it happened to. A rule set off again for the
// same lead by its own changes or another rule's, in one go, is stopped and logged (the loop guard). Rules for when the
// call list runs out run from there too, in your order, until one puts leads on the list.

const RULES = 'rules';

/** Your rules, then the ones your tag shortcuts write (made fresh each time, with your tags' names now). */
export function loadRules(db: DB): Rule[] {
  const r = Rules.safeParse(getSetting<unknown>(db, RULES) ?? []);
  // A bad stored value never blocks the app: no rules until they're saved again.
  return [...(r.success ? r.data.filter((x) => !x.made_by) : []), ...loadShortcutRules(db)];
}

const SHORTCUTS = 'tag_shortcuts';

export function loadTagShortcuts(db: DB): TagShortcuts {
  const r = TagShortcuts.safeParse(getSetting<unknown>(db, SHORTCUTS) ?? { expiry: [], groups: [] });
  return r.success ? r.data : { expiry: [], groups: [] };
}

function loadShortcutRules(db: DB): Rule[] {
  const names = new Map((db.prepare('SELECT id, name FROM tag').all() as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  return shortcutRules(loadTagShortcuts(db), (id) => names.get(id));
}

/** Saves your tag shortcuts; the rules they write change with them. */
export function saveTagShortcuts(db: DB, input: unknown): { shortcuts: TagShortcuts; rules: Rule[] } {
  const sc = TagShortcuts.parse(input);
  const tags = new Set((db.prepare('SELECT id FROM tag').all() as { id: string }[]).map((t) => t.id));
  for (const x of sc.expiry) if (!tags.has(x.tag_id)) throw new DomainError('that tag is gone');
  if (new Set(sc.expiry.map((x) => x.tag_id)).size !== sc.expiry.length) throw new DomainError('a tag can only be taken off one way');
  if (new Set(sc.groups.map((g) => g.id)).size !== sc.groups.length) throw new DomainError('two groups have the same id');
  for (const g of sc.groups) {
    if (g.tag_ids.some((id) => !tags.has(id))) throw new DomainError(`${g.name}: one of its tags is gone`);
    if (new Set(g.tag_ids).size !== g.tag_ids.length) throw new DomainError(`${g.name}: a tag is in it twice`);
  }
  setSetting(db, SHORTCUTS, sc);
  return { shortcuts: sc, rules: loadShortcutRules(db) };
}

/** Saves your rules. Rules a tag shortcut wrote are left out: they change with their shortcut. */
export function saveRules(db: DB, input: unknown): Rule[] {
  const rules = Rules.parse(input).filter((r) => !r.made_by);
  if (new Set(rules.map((r) => r.id)).size !== rules.length) throw new DomainError('two rules have the same id');
  const fields = new Map(listCustomFields(db).map((f) => [f.id, f]));
  const outcomes = new Set((db.prepare('SELECT code FROM outcome_code').all() as { code: string }[]).map((o) => o.code));
  for (const r of rules) {
    LeadQuery.parse(r.filter);
    if (r.filter.where?.trim()) {
      try {
        conditionSql(db, r.filter.where);
      } catch (e) {
        throw new DomainError(`${r.name}: the condition: ${(e as Error).message}`);
      }
    }
    // A first "leads imported" rule starts from the leads there now, so the next import is the first it acts on.
    if (r.trigger.kind === 'imported' && getSetting(db, IMPORT_CURSOR) == null) newLeads(db);
    if (r.trigger.kind === 'call_saved') for (const o of r.trigger.outcomes) if (!outcomes.has(o)) throw new DomainError(`${r.name}: unknown outcome "${o}"`);
    if (r.trigger.kind === 'status') {
      const id = r.trigger.status_id;
      if (!loadStatusDefs(db).some((st) => st.id === id)) throw new DomainError(`${r.name}: that status is gone`);
    }
    if (r.trigger.kind === 'becomes_true') {
      try {
        conditionSql(db, r.trigger.condition);
      } catch (e) {
        throw new DomainError(`${r.name}: the condition: ${(e as Error).message}`);
      }
    }
    if (r.actions.at(-1)?.kind === 'wait') throw new DomainError(`${r.name}: a wait needs a step after it`);
    for (const a of r.actions) {
      if (a.kind === 'counter') {
        const f = fields.get(a.field_id);
        if (f?.type !== 'counter') throw new DomainError(`${r.name}: that counter is gone`);
        continue;
      }
      if (a.kind !== 'set_field') continue;
      const f = fields.get(a.field_id);
      if (!f) throw new DomainError(`${r.name}: that field is gone`);
      if (f.type === 'formula') throw new DomainError(`${r.name}: ${f.label} is worked out from its formula, so a rule can't set it`);
      if (f.type === 'counter') throw new DomainError(`${r.name}: ${f.label} is a counter, so use "Change a counter"`);
      try {
        normalizeCustomValue(f, a.value);
      } catch (e) {
        throw new DomainError(`${r.name}: ${(e as Error).message}`);
      }
    }
  }
  setSetting(db, RULES, rules);
  return loadRules(db);
}

/**
 * Does the rule's steps from `from` on to these leads, and says what each changed. A wait stops there: the leads wait
 * in rule_wait, and the rule runner does the rest when it's due.
 */
function doSteps(db: DB, rule: Rule, ids: string[], from: number, now: string): ActionResult[] {
  const out: ActionResult[] = [];
  for (let i = from; i < rule.actions.length; i++) {
    const a = rule.actions[i]!;
    if (a.kind === 'wait') {
      const due = afterStep(now, a.after);
      const ins = db.prepare('INSERT INTO rule_wait (id, rule_id, lead_id, next_step, due_at, created_at) VALUES (?,?,?,?,?,?)');
      for (const id of ids) ins.run(uuidv7(), rule.id, id, i + 1, due, now);
      out.push({ action: a, changed: ids.length, note: ids.length ? `the rest from ${new Date(due).toLocaleString()}` : null });
      break;
    }
    out.push(doAction(db, rule, a, ids, now));
  }
  return out;
}

/** Does one action to these leads and says what changed. */
function doAction(db: DB, rule: Rule, a: Exclude<RuleAction, { kind: 'wait' }>, ids: string[], now: string): ActionResult {
  switch (a.kind) {
    case 'add_to_list': {
      const r = addToCallList(db, ids, now);
      const note = [r.already ? `${r.already} already on it` : '', r.not_callable ? `${r.not_callable} booked, bad or dead` : ''].filter(Boolean).join(', ');
      return { action: a, changed: r.added, note: note || null };
    }
    case 'remove_from_list':
      return { action: a, changed: ids.filter((id) => removeFromCallList(db, id)).length, note: null };
    case 'add_tag':
      return { action: a, changed: setTagOnLeads(db, ids, ensureTag(db, a.tag, now).id, true, now, { source: 'rule', id: rule.id, name: rule.name }), note: null };
    case 'remove_tag': {
      const t = tagByName(db, a.tag.trim());
      return t ? { action: a, changed: setTagOnLeads(db, ids, t.id, false, now, { source: 'rule', id: rule.id, name: rule.name }), note: null } : { action: a, changed: 0, note: `no tag called "${a.tag}"` };
    }
    case 'set_field':
      return { action: a, changed: ids.filter((id) => setCustomValues(db, id, { [a.field_id]: a.value }, now) > 0).length, note: null };
    case 'mark_dead': {
      const dead = new Set((db.prepare("SELECT lead_id FROM lead_state WHERE status = 'dead' AND lead_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { lead_id: string }[]).map((r) => r.lead_id));
      const todo = ids.filter((id) => !dead.has(id));
      for (const id of todo) addLeadAction(db, id, 'mark_dead', a.reason?.trim() || `Rule: ${rule.name}`);
      return { action: a, changed: todo.length, note: dead.size ? `${dead.size} already in it` : null };
    }
    case 'counter': {
      const get = db.prepare('SELECT value FROM lead_custom_value WHERE lead_id = ? AND field_id = ?');
      let changed = 0;
      for (const id of ids) {
        const old = Number((get.get(id, a.field_id) as { value: string } | undefined)?.value ?? 0);
        const next = a.op === 'add' ? old + a.by : a.by;
        if (next !== old && setCustomValues(db, id, { [a.field_id]: String(next) }, now, { counters: true })) changed++;
      }
      return { action: a, changed, note: null };
    }
    case 'come_back':
      return { action: a, changed: setComeback(db, ids, a.steps, { rule_id: rule.id, rule_name: rule.name }, now), note: null };
  }
}

const ROLLBACK = new Error('preview');

/** Triggers that run from runEventRules. A run of one that matched no lead isn't logged (there'd be one per change). */
const EVENT_TRIGGERS: readonly RuleTrigger['kind'][] = ['tag_added', 'tag_removed', 'status', 'becomes_true', 'imported'];

/**
 * Runs a rule now: for every lead matching its filter (or just those of `leadIds` that do, for a change to them), does
 * its actions. With dryRun nothing is kept or logged; the result says what would have happened.
 */
export function runRule(
  db: DB,
  rule: Rule,
  trigger: RuleRun['trigger'],
  opts: { dryRun?: boolean; leadIds?: string[]; now?: Date; matched?: (ids: string[]) => void; from?: number } = {},
): RuleRun {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const run: RuleRun = { id: uuidv7(), rule_id: rule.id, rule_name: rule.name, trigger, at, dry_run: !!opts.dryRun, matched: 0, results: [], leads: [], error: null };
  let ids: string[] = [];
  try {
    db.transaction(() => {
      ids = matchingLeadIds(db, { ...toLeadFilter(LeadQuery.parse(rule.filter), now), ...(opts.leadIds ? { only_leads: opts.leadIds } : {}) });
      if (trigger === 'list_empty') ids = withoutListed(db, rule, ids);
      run.matched = ids.length;
      run.results = doSteps(db, rule, ids, opts.from ?? 0, nowIso());
      if (opts.dryRun) throw ROLLBACK;
    })();
  } catch (e) {
    if (e !== ROLLBACK) {
      run.error = (e as Error).message;
      run.results = [];
    }
  }
  opts.matched?.(ids);
  if (!opts.dryRun && !ids.length && !run.error && trigger !== 'wait' && EVENT_TRIGGERS.includes(trigger)) return run;
  const shown = ids.slice(0, 50);
  const name = db.prepare(`SELECT ${LEAD_NAME} name FROM lead l WHERE l.id = ?`);
  run.leads = shown.map((id) => ({ id, name: (name.get(id) as { name: string } | undefined)?.name || 'No name' }));
  if (!opts.dryRun) logRun(db, run, ids);
  return run;
}

function logRun(db: DB, run: RuleRun, ids: string[]) {
  db.prepare('INSERT INTO rule_run (id, rule_id, rule_name, trigger, at, matched, results_json, lead_ids_json, error) VALUES (?,?,?,?,?,?,?,?,?)').run(
    run.id, run.rule_id, run.rule_name, run.trigger, run.at, run.matched, JSON.stringify(run.results), JSON.stringify(ids.slice(0, 500)), run.error,
  );
}

/** Runs one saved rule now (Run now), or shows what it would do (Preview). */
export function runRuleById(db: DB, id: string, dryRun: boolean): RuleRun {
  const rule = loadRules(db).find((r) => r.id === id);
  if (!rule) throw new DomainError('that rule is gone', 404);
  return runRule(db, rule, 'manual', { dryRun });
}

/** A rule as it would run from Settings before it's saved: Preview of an edited rule. */
export function previewRule(db: DB, input: unknown): RuleRun {
  const [rule] = Rules.parse([input]);
  return runRule(db, rule!, 'manual', { dryRun: true });
}

/** YYYY-MM-DD on this computer. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Runs each switched-on daily rule that is due: today is one of its days, its time has passed, and it hasn't run
 * today. If the app was closed at that time, it runs when the app next opens that day.
 */
export function runDueDailyRules(db: DB, now = new Date()): RuleRun[] {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const ranToday = db.prepare("SELECT 1 FROM rule_run WHERE rule_id = ? AND trigger = 'daily' AND date(at, 'localtime') = ?");
  const today = localDay(now);
  return loadRules(db)
    .filter((r) => r.enabled && r.trigger.kind === 'daily' && r.trigger.days.includes(now.getDay()) && r.trigger.time <= hhmm && !ranToday.get(r.id, today))
    .map((r) => runRule(db, r, 'daily', { now }));
}

/** After a call is saved: runs the switched-on rules for that outcome, on that call's lead. */
export function runCallRules(db: DB, callId: string, now = new Date()): RuleRun[] {
  const call = db.prepare(
    `SELECT c.lead_id, (SELECT o.outcome_code FROM call_outcome o WHERE o.call_id = c.id ORDER BY o.entered_at DESC LIMIT 1) outcome
     FROM call c WHERE c.id = ?`,
  ).get(callId) as { lead_id: string | null; outcome: string | null } | undefined;
  if (!call?.lead_id || !call.outcome) return [];
  return loadRules(db)
    .filter((r) => r.enabled && r.trigger.kind === 'call_saved' && (!r.trigger.outcomes.length || r.trigger.outcomes.includes(call.outcome!)))
    .map((r) => runRule(db, r, 'call_saved', { leadIds: [call.lead_id!], now }));
}

const CURSOR = 'rule_event_cursor';
const WATCH_KEYS = 'rule_watch_keys';
/** The most rounds of rules setting off rules in one go. Each rule runs at most once per lead per go, so it ends sooner. */
const MAX_ROUNDS = 25;

/** The tag lines logged since the last look (none the first time: history doesn't set rules off). */
const IMPORT_CURSOR = 'rule_import_cursor';

/** Leads added since the last look (by rowid), for "when leads are imported". The first look only notes where it is. */
function newLeads(db: DB): string[] {
  const last = (db.prepare('SELECT max(rowid) n FROM lead').get() as { n: number | null }).n ?? 0;
  const from = getSetting<number>(db, IMPORT_CURSOR);
  if (from === last) return [];
  setSetting(db, IMPORT_CURSOR, last);
  if (from == null) return [];
  return (db.prepare('SELECT id FROM lead WHERE rowid > ? AND rowid <= ? ORDER BY rowid').all(from, last) as { id: string }[]).map((r) => r.id);
}

function newTagEvents(db: DB): { lead_id: string; kind: string; tag_name: string }[] {
  const last = (db.prepare('SELECT max(rowid) n FROM lead_event').get() as { n: number | null }).n ?? 0;
  const from = getSetting<number>(db, CURSOR);
  if (from === last) return [];
  setSetting(db, CURSOR, last);
  if (from == null) return [];
  return db
    .prepare("SELECT lead_id, kind, tag_name FROM lead_event WHERE rowid > ? AND rowid <= ? AND kind IN ('tag_added', 'tag_removed') ORDER BY rowid")
    .all(from, last) as { lead_id: string; kind: string; tag_name: string }[];
}

/**
 * For a status or condition trigger: the leads it fires for now (who came in, or went out for "leaves"), and notes who's
 * in for next time. A new or changed rule only notes who's in, so switching one on doesn't fire for every lead.
 */
function watchedChange(db: DB, rule: Rule, now: Date): string[] {
  const t = rule.trigger;
  if (t.kind !== 'status' && t.kind !== 'becomes_true') return [];
  const query = t.kind === 'status' ? { in_status: t.status_id } : { where: t.condition };
  const inNow = matchingLeadIds(db, toLeadFilter(LeadQuery.parse(query), now));
  const before = new Set((db.prepare('SELECT lead_id FROM rule_watch WHERE rule_id = ?').all(rule.id) as { lead_id: string }[]).map((r) => r.lead_id));
  const nowSet = new Set(inNow);
  const came = inNow.filter((id) => !before.has(id));
  const went = [...before].filter((id) => !nowSet.has(id));
  const keys = getSetting<Record<string, string>>(db, WATCH_KEYS) ?? {};
  const key = JSON.stringify(t);
  db.transaction(() => {
    const add = db.prepare('INSERT INTO rule_watch (rule_id, lead_id) VALUES (?, ?)');
    const del = db.prepare('DELETE FROM rule_watch WHERE rule_id = ? AND lead_id = ?');
    for (const id of came) add.run(rule.id, id);
    for (const id of went) del.run(rule.id, id);
    if (keys[rule.id] !== key) setSetting(db, WATCH_KEYS, { ...keys, [rule.id]: key });
  })();
  if (keys[rule.id] !== key) return t.kind === 'becomes_true' && t.already ? inNow : [];
  if (t.kind === 'status' && t.when === 'leaves') {
    const live = db.prepare('SELECT 1 FROM lead WHERE id = ?');
    return went.filter((id) => live.get(id));
  }
  return came;
}

/** Forgets who was in for rules that are gone, off, or no longer watch, so switching one back on starts fresh. */
function forgetWatches(db: DB, watching: Rule[]) {
  const keep = new Set(watching.map((r) => r.id));
  const keys = getSetting<Record<string, string>>(db, WATCH_KEYS) ?? {};
  const gone = Object.keys(keys).filter((id) => !keep.has(id));
  if (!gone.length) return;
  db.transaction(() => {
    const del = db.prepare('DELETE FROM rule_watch WHERE rule_id = ?');
    for (const id of gone) {
      del.run(id);
      delete keys[id];
    }
    setSetting(db, WATCH_KEYS, keys);
  })();
}

/**
 * Runs the switched-on rules for what changed on leads since the last look: tags put on or taken off, statuses entered
 * or left, conditions turned true. What those rules change can set off more rules, round after round; a rule set off
 * again for a lead it already ran on in this go is stopped for that lead, and the log says so.
 */
export function runEventRules(db: DB, now = new Date()): RuleRun[] {
  const rules = loadRules(db).filter((r) => r.enabled && EVENT_TRIGGERS.includes(r.trigger.kind));
  forgetWatches(db, rules.filter((r) => r.trigger.kind === 'status' || r.trigger.kind === 'becomes_true'));
  const runs: RuleRun[] = [];
  const ran = new Map<string, Set<string>>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const events = newTagEvents(db);
    const imported = newLeads(db);
    const due: [Rule, string[]][] = [];
    for (const r of rules) {
      const t = r.trigger;
      let ids: string[];
      if (t.kind === 'tag_added' || t.kind === 'tag_removed') {
        const tag = t.tag.toLowerCase();
        ids = [...new Set(events.filter((e) => e.kind === t.kind && e.tag_name?.toLowerCase() === tag).map((e) => e.lead_id))];
      } else if (t.kind === 'imported') {
        ids = imported;
      } else {
        try {
          ids = watchedChange(db, r, now);
        } catch {
          ids = []; // A status deleted since, or a condition that no longer reads: the Rules card shows it.
        }
      }
      if (ids.length) due.push([r, ids]);
    }
    if (!due.length) break;
    for (const [r, ids] of due) {
      const seen = ran.get(r.id) ?? new Set<string>();
      ran.set(r.id, seen);
      const again = ids.filter((id) => seen.has(id));
      const fresh = ids.filter((id) => !seen.has(id));
      if (fresh.length) runs.push(runRule(db, r, r.trigger.kind, { leadIds: fresh, now, matched: (m) => m.forEach((id) => seen.add(id)) }));
      if (again.length) runs.push(stoppedLoop(db, r, again, now));
    }
  }
  // The list may have run out with that change (the last lead called): the rules for that fill it.
  runs.push(...runListOutRules(db, now));
  return runs;
}

/** Every lead on the call list has been called since it went on (an empty list, after Clear worked leads, too). */
function listRanOut(db: DB): boolean {
  return !(db.prepare(`SELECT 1 FROM call_list_item i WHERE NOT ${WORKED} LIMIT 1`).get());
}

/** Minutes a rule waits between dials of a lead ("Not dialed in the last …"), or 0. */
const gapOf = (rule: Rule) => LeadQuery.partial().safeParse(rule.filter).data?.not_within_min ?? 0;

/**
 * Filling a list that ran out leaves out leads still waiting on it. A lead already called from the list comes back
 * only when the rule waits between dials ("Not dialed in the last …"), so a rule without one can't put the lead you
 * just called straight back on, over and over.
 */
function withoutListed(db: DB, rule: Rule, ids: string[]): string[] {
  const on = new Set((db.prepare(`SELECT i.lead_id FROM call_list_item i${gapOf(rule) ? ` WHERE NOT ${WORKED}` : ''}`).all() as { lead_id: string }[]).map((r) => r.lead_id));
  return ids.filter((id) => !on.has(id));
}

/** What the "list runs out" rules will add next, when the list has run out and none of them has anyone to add now. */
export interface ListRefill {
  /** How many "list runs out" rules are switched on. */
  rules: number;
  /** The first rule in your order with leads waiting out its "Not dialed in the last …": how many, and when the first is ready. */
  next: { rule_name: string; leads: number; ready_at: string } | null;
}

export function listRefill(db: DB, now = new Date()): ListRefill | null {
  const rules = loadRules(db).filter((r) => r.enabled && r.trigger.kind === 'list_empty');
  if (!rules.length || !listRanOut(db)) return null;
  const last = db.prepare('SELECT last_call_at FROM lead_state WHERE lead_id = ?');
  for (const r of rules) {
    const gap = gapOf(r);
    if (!gap) continue;
    let ids: string[];
    try {
      ids = withoutListed(db, r, matchingLeadIds(db, { ...toLeadFilter(LeadQuery.parse(r.filter), now), not_within_min: undefined }));
    } catch {
      continue; // A filter that no longer reads: the Rules card shows it.
    }
    // Only leads it would really add: ones that can be called and have no never-dial tag.
    const callable = callableIds(db, ids);
    const never = neverDialOf(db, ids);
    const since = now.getTime() - gap * 60_000;
    const waits = ids
      .filter((id) => callable.has(id) && !never.has(id))
      .map((id) => Date.parse((last.get(id) as { last_call_at: string | null } | undefined)?.last_call_at ?? ''))
      .filter((t) => t >= since);
    if (waits.length) return { rules: rules.length, next: { rule_name: r.name, leads: waits.length, ready_at: new Date(Math.min(...waits) + gap * 60_000).toISOString() } };
  }
  return { rules: rules.length, next: null };
}

/**
 * When the call list runs out: the switched-on "list runs out" rules, in your order, until one puts leads on the list.
 * One that would add nothing isn't run (or logged), so it waits for the next time.
 */
export function runListOutRules(db: DB, now = new Date()): RuleRun[] {
  const rules = loadRules(db).filter((r) => r.enabled && r.trigger.kind === 'list_empty');
  if (!rules.length || !listRanOut(db)) return [];
  const runs: RuleRun[] = [];
  for (const r of rules) {
    const fills = (run: RuleRun) => run.results.some((x) => x.action.kind === 'add_to_list' && x.changed > 0);
    if (!fills(runRule(db, r, 'list_empty', { dryRun: true, now }))) continue;
    const run = runRule(db, r, 'list_empty', { now });
    runs.push(run);
    if (fills(run)) break;
  }
  return runs;
}

/**
 * Once, after the update that took routines away: each step of your routines that picked leads by filters becomes a
 * "when the call list runs out" rule adding them, in the same order, switched on. Steps that loaded a saved list have
 * no rule to become, so they're left out.
 */
export function routinesToRules(db: DB): number {
  if (getSetting<boolean>(db, 'routines_to_rules_done')) return 0;
  const routines = getSetting<{ steps?: { name?: string; source?: { kind?: string; filter?: unknown } }[] }[]>(db, 'routines') ?? [];
  const made: Rule[] = [];
  const names = new Set<string>();
  for (const routine of Array.isArray(routines) ? routines : []) {
    for (const step of routine.steps ?? []) {
      const filter = LeadQuery.partial().safeParse(step.source?.filter);
      const name = `Then ${step.name ?? 'a routine step'}`.slice(0, 80);
      if (step.source?.kind !== 'filter' || !filter.success || names.has(name.toLowerCase())) continue;
      names.add(name.toLowerCase());
      made.push({ id: uuidv7(), name, enabled: true, trigger: { kind: 'list_empty' }, filter: filter.data, actions: [{ kind: 'add_to_list' }] });
    }
  }
  db.transaction(() => {
    if (made.length) saveRules(db, [...loadRules(db), ...made]);
    setSetting(db, 'routines_to_rules_done', true);
  })();
  return made.length;
}

/** Logs that a rule was set off again for leads it already ran on in this go, and didn't run. */
function stoppedLoop(db: DB, rule: Rule, ids: string[], now: Date): RuleRun {
  const name = db.prepare(`SELECT ${LEAD_NAME} name FROM lead l WHERE l.id = ?`);
  const run: RuleRun = {
    id: uuidv7(), rule_id: rule.id, rule_name: rule.name, trigger: rule.trigger.kind, at: now.toISOString(), dry_run: false, matched: ids.length, results: [],
    leads: ids.slice(0, 50).map((id) => ({ id, name: (name.get(id) as { name: string } | undefined)?.name || 'No name' })),
    error: 'stopped a loop: what this rule (or another rule) changed set it off again for the same lead, so it ran only once',
  };
  logRun(db, run, ids);
  return run;
}

/** The latest runs, newest first: all rules, or one. Runs that matched no lead are left out unless `all`. */
export function ruleRuns(db: DB, opts: { ruleId?: string; limit?: number; all?: boolean } = {}): RuleRun[] {
  const rows = db.prepare(
    `SELECT * FROM rule_run WHERE (@rule IS NULL OR rule_id = @rule) AND (@all = 1 OR matched > 0 OR error IS NOT NULL)
     ORDER BY at DESC LIMIT @limit`,
  ).all({ rule: opts.ruleId ?? null, all: opts.all ? 1 : 0, limit: opts.limit ?? 30 }) as {
    id: string; rule_id: string; rule_name: string; trigger: RuleRun['trigger']; at: string; matched: number; results_json: string; lead_ids_json: string; error: string | null;
  }[];
  const name = db.prepare(`SELECT ${LEAD_NAME} name FROM lead l WHERE l.id = ?`);
  return rows.map((r) => ({
    id: r.id, rule_id: r.rule_id, rule_name: r.rule_name, trigger: r.trigger, at: r.at, dry_run: false, matched: r.matched,
    results: JSON.parse(r.results_json) as ActionResult[], error: r.error,
    leads: (JSON.parse(r.lead_ids_json) as string[]).slice(0, 50).map((id) => ({ id, name: (name.get(id) as { name: string } | undefined)?.name || 'Deleted lead' })),
  }));
}

/**
 * The steps after a wait, for the leads whose wait is over: each rule goes on from where it stopped (to the next wait).
 * A lead waiting on a rule that's gone or switched off since is let go.
 */
export function runWaitingRules(db: DB, now = new Date()): RuleRun[] {
  const due = db.prepare('SELECT id, rule_id, lead_id, next_step FROM rule_wait WHERE due_at <= ? ORDER BY due_at').all(now.toISOString()) as
    { id: string; rule_id: string; lead_id: string; next_step: number }[];
  if (!due.length) return [];
  const rules = new Map(loadRules(db).map((r) => [r.id, r]));
  const groups = new Map<string, { rule: Rule | undefined; from: number; leads: string[] }>();
  for (const w of due) {
    const key = `${w.rule_id}|${w.next_step}`;
    const g = groups.get(key) ?? { rule: rules.get(w.rule_id), from: w.next_step, leads: [] };
    g.leads.push(w.lead_id);
    groups.set(key, g);
  }
  db.prepare('DELETE FROM rule_wait WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(due.map((w) => w.id)));
  const runs: RuleRun[] = [];
  for (const g of groups.values()) {
    if (!g.rule?.enabled || g.from >= g.rule.actions.length) continue;
    // Its steps go to the leads that waited, whether or not they'd still match its filter, like a workflow.
    const leads = [...new Set(g.leads)];
    runs.push(runRule(db, { ...g.rule, filter: {} }, 'wait', { leadIds: leads, now, from: g.from }));
  }
  return runs;
}

/** Checks for due daily rules, and conditions turned true, every minute while the app runs. */
export class RuleRunner {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(private db: DB, private warn: (m: string) => void = () => {}) {}

  start(firstAfterMs = 10_000) {
    const tick = () => {
      try {
        for (const r of [...runDueDailyRules(this.db), ...runWaitingRules(this.db), ...runEventRules(this.db)]) if (r.error) this.warn(`rule "${r.rule_name}" failed: ${r.error}`);
      } catch (e) {
        this.warn(`rules check failed: ${(e as Error).message}`);
      }
    };
    this.first = setTimeout(tick, firstAfterMs);
    this.timer = setInterval(tick, 60_000);
    this.first.unref();
    this.timer.unref();
  }

  stop() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }
}
