import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { DomainError } from '../core/errors.js';
import { nowIso, uuidv7 } from '../ids.js';
import { LEAD_NAME } from '../db/sql.js';
import { LeadQuery } from '../../shared/leadFilter.js';
import { normalizeCustomValue } from '../../shared/customFields.js';
import { Rules, type ActionResult, type Rule, type RuleAction, type RuleRun, type RuleTrigger } from '../../shared/rules.js';
import { addToCallList, matchingLeadIds, removeFromCallList, toLeadFilter } from './callList.js';
import { ensureTag, setTagOnLeads, tagByName } from './tags.js';
import { listCustomFields, setCustomValues } from './customFields.js';
import { addLeadAction } from './calls.js';
import { conditionSql, loadStatusDefs } from './formulas.js';

// Rules (shared/rules.ts): stored as one setting, run by their trigger, every run written to rule_run.
// A run finds the leads matching the rule's filter now, then does each action to them in order, in one transaction:
// if any action fails, nothing changes and the log says why. Preview does the same and then undoes it.
// Rules on a lead's changes (a tag put on or taken off, a status entered or left, a condition turning true) run from
// runEventRules after each change and every minute, on just the leads it happened to. A rule set off again for the
// same lead by its own changes or another rule's, in one go, is stopped and logged (the loop guard).

const RULES = 'rules';

export function loadRules(db: DB): Rule[] {
  const r = Rules.safeParse(getSetting<unknown>(db, RULES) ?? []);
  // A bad stored value never blocks the app: no rules until they're saved again.
  return r.success ? r.data : [];
}

export function saveRules(db: DB, input: unknown): Rule[] {
  const rules = Rules.parse(input);
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
  return rules;
}

/** Does one action to these leads and says what changed. */
function doAction(db: DB, rule: Rule, a: RuleAction, ids: string[], now: string): ActionResult {
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
  }
}

const ROLLBACK = new Error('preview');

/** Triggers that run from runEventRules. A run of one that matched no lead isn't logged (there'd be one per change). */
const EVENT_TRIGGERS: readonly RuleTrigger['kind'][] = ['tag_added', 'tag_removed', 'status', 'becomes_true'];

/**
 * Runs a rule now: for every lead matching its filter (or just those of `leadIds` that do, for a change to them), does
 * its actions. With dryRun nothing is kept or logged; the result says what would have happened.
 */
export function runRule(
  db: DB,
  rule: Rule,
  trigger: RuleRun['trigger'],
  opts: { dryRun?: boolean; leadIds?: string[]; now?: Date; matched?: (ids: string[]) => void } = {},
): RuleRun {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const run: RuleRun = { id: uuidv7(), rule_id: rule.id, rule_name: rule.name, trigger, at, dry_run: !!opts.dryRun, matched: 0, results: [], leads: [], error: null };
  let ids: string[] = [];
  try {
    db.transaction(() => {
      ids = matchingLeadIds(db, { ...toLeadFilter(LeadQuery.parse(rule.filter), now), ...(opts.leadIds ? { only_leads: opts.leadIds } : {}) });
      run.matched = ids.length;
      run.results = rule.actions.map((a) => doAction(db, rule, a, ids, nowIso()));
      if (opts.dryRun) throw ROLLBACK;
    })();
  } catch (e) {
    if (e !== ROLLBACK) {
      run.error = (e as Error).message;
      run.results = [];
    }
  }
  opts.matched?.(ids);
  if (!opts.dryRun && !ids.length && !run.error && EVENT_TRIGGERS.includes(trigger)) return run;
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
  if (keys[rule.id] !== key) return [];
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
    const due: [Rule, string[]][] = [];
    for (const r of rules) {
      const t = r.trigger;
      let ids: string[];
      if (t.kind === 'tag_added' || t.kind === 'tag_removed') {
        const tag = t.tag.toLowerCase();
        ids = [...new Set(events.filter((e) => e.kind === t.kind && e.tag_name?.toLowerCase() === tag).map((e) => e.lead_id))];
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
  return runs;
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

/** Checks for due daily rules, and conditions turned true, every minute while the app runs. */
export class RuleRunner {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(private db: DB, private warn: (m: string) => void = () => {}) {}

  start(firstAfterMs = 10_000) {
    const tick = () => {
      try {
        for (const r of [...runDueDailyRules(this.db), ...runEventRules(this.db)]) if (r.error) this.warn(`rule "${r.rule_name}" failed: ${r.error}`);
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
