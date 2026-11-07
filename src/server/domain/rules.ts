import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { DomainError } from '../core/errors.js';
import { nowIso, uuidv7 } from '../ids.js';
import { LEAD_NAME } from '../db/sql.js';
import { LeadQuery } from '../../shared/leadFilter.js';
import { normalizeCustomValue } from '../../shared/customFields.js';
import { Rules, type ActionResult, type Rule, type RuleAction, type RuleRun } from '../../shared/rules.js';
import { addToCallList, matchingLeadIds, removeFromCallList, toLeadFilter } from './callList.js';
import { ensureTag, setTagOnLeads, tagByName } from './tags.js';
import { listCustomFields, setCustomValues } from './customFields.js';
import { addLeadAction } from './calls.js';
import { conditionSql } from './formulas.js';

// Rules (shared/rules.ts): stored as one setting, run by their trigger, every run written to rule_run.
// A run finds the leads matching the rule's filter now, then does each action to them in order, in one transaction:
// if any action fails, nothing changes and the log says why. Preview does the same and then undoes it.

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
    for (const a of r.actions) {
      if (a.kind !== 'set_field') continue;
      const f = fields.get(a.field_id);
      if (!f) throw new DomainError(`${r.name}: that field is gone`);
      if (f.type === 'formula') throw new DomainError(`${r.name}: ${f.label} is worked out from its formula, so a rule can't set it`);
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
  }
}

const ROLLBACK = new Error('preview');

/**
 * Runs a rule now: for every lead matching its filter (or just `leadId`, for a call), does its actions. With dryRun
 * nothing is kept or logged; the result says what would have happened.
 */
export function runRule(
  db: DB,
  rule: Rule,
  trigger: RuleRun['trigger'],
  opts: { dryRun?: boolean; leadId?: string; now?: Date } = {},
): RuleRun {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const run: RuleRun = { id: uuidv7(), rule_id: rule.id, rule_name: rule.name, trigger, at, dry_run: !!opts.dryRun, matched: 0, results: [], leads: [], error: null };
  let ids: string[] = [];
  try {
    db.transaction(() => {
      ids = matchingLeadIds(db, { ...toLeadFilter(LeadQuery.parse(rule.filter), now), ...(opts.leadId ? { only_lead: opts.leadId } : {}) });
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
  const shown = ids.slice(0, 50);
  const name = db.prepare(`SELECT ${LEAD_NAME} name FROM lead l WHERE l.id = ?`);
  run.leads = shown.map((id) => ({ id, name: (name.get(id) as { name: string } | undefined)?.name || 'No name' }));
  if (!opts.dryRun) {
    db.prepare('INSERT INTO rule_run (id, rule_id, rule_name, trigger, at, matched, results_json, lead_ids_json, error) VALUES (?,?,?,?,?,?,?,?,?)').run(
      run.id, rule.id, rule.name, trigger, at, run.matched, JSON.stringify(run.results), JSON.stringify(ids.slice(0, 500)), run.error,
    );
  }
  return run;
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
    .map((r) => runRule(db, r, 'call_saved', { leadId: call.lead_id!, now }));
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

/** Checks for due daily rules every minute while the app runs. */
export class RuleRunner {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(private db: DB, private warn: (m: string) => void = () => {}) {}

  start(firstAfterMs = 10_000) {
    const tick = () => {
      try {
        for (const r of runDueDailyRules(this.db)) if (r.error) this.warn(`rule "${r.rule_name}" failed: ${r.error}`);
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
