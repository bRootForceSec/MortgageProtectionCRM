import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime, newKey } from '../api';
import { useApp } from '../App';
import { useTags } from '../tags';
import { useStatuses } from '../statuses';
import { useCustomFields } from '../customFields';
import { CustomFieldInput } from '../components/CustomFieldInput';
import { ConditionEditor } from '../components/ConditionEditor';
import { RULES_CHANGED, madeByText } from './TagShortcuts';
import { pythonToRule, ruleToPython, RuleTextError, type RuleNames } from '../../shared/ruleText';
import { describeFilter } from '../../shared/leadFilter';
import { WEEKDAYS } from '../../shared/rules';
import { APPT_DAYS, LAST_CALL, type LeadQuery } from '../../shared/leadFilter';
import { LEAD_TABS } from '../../shared/leadStatus';
import { isStep, parsePlan } from '../../shared/followUps';
import {
  ACTION_LABELS, STARTER_RULES, TRIGGER_LABELS, describeAction, describeTrigger, describeWait,
  type ActionResult, type Rule, type RuleAction, type RuleRun, type RuleTrigger,
} from '../../shared/rules';

// Automation → Rules: "when this happens, for leads like these, do that". Each rule shows what it does in words, with
// Preview (what it would do now, changing nothing), Run now, and the log of what it did.

type Filter = Partial<LeadQuery>;

/** The names the descriptions need: tags, your fields and outcomes. */
function useNames() {
  const { meta } = useApp();
  const { tags, tagName } = useTags();
  const { fields, fieldName, reload: reloadFields } = useCustomFields();
  const { statuses, statusName, reload: reloadStatuses } = useStatuses();
  const outcomeLabel = useCallback((c: string) => meta?.outcome_codes.find((o) => o.code === c)?.label ?? c, [meta]);
  // Fields and statuses made elsewhere in Settings since this screen opened: load them again when a rule is saved.
  const reload = useCallback(() => void Promise.all([reloadFields(), reloadStatuses()]), [reloadFields, reloadStatuses]);
  return { tags, tagName, fields, fieldName, statuses, statusName, outcomeLabel, reload };
}

/** The list with items i and j swapped. */
const swap = <T,>(list: T[], i: number, j: number): T[] => {
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

/** What set a run off, for the log. */
const RUN_TRIGGER: Record<RuleRun['trigger'], string> = {
  wait: 'after a wait', daily: 'daily', call_saved: 'call saved', manual: 'run by you', tag_added: 'tag put on', tag_removed: 'tag taken off', status: 'smart list', becomes_true: 'condition turned true', list_empty: 'call list ran out', imported: 'leads imported',
};

function resultText(r: ActionResult, fieldName: (id: string) => string | undefined): string {
  return `${describeAction(r.action, fieldName)}: ${r.changed} lead${r.changed === 1 ? '' : 's'}${r.note ? ` (${r.note})` : ''}`;
}

/** What a run did (or Preview would do), in a few lines. */
export function RunSummary({ run, fieldName }: { run: RuleRun; fieldName: (id: string) => string | undefined }) {
  if (run.error?.startsWith('stopped a loop')) {
    return <div className="error">Stopped a loop for {run.leads.map((l) => l.name).join(', ')}: this rule's changes, or another rule's, set it off again, so it ran only once for {run.matched === 1 ? 'that lead' : 'them'}.</div>;
  }
  if (run.error) return <div className="error">Didn't run: {run.error}. Nothing was changed.</div>;
  return (
    <div>
      <div>{run.dry_run ? 'Would match' : 'Matched'} <b>{run.matched}</b> lead{run.matched === 1 ? '' : 's'}{run.leads.length ? `: ${run.leads.slice(0, 8).map((l) => l.name).join(', ')}${run.matched > 8 ? '…' : ''}` : ''}</div>
      {run.matched > 0 && <ul className="help" style={{ margin: '2px 0 0 18px' }}>{run.results.map((r, i) => <li key={i}>{resultText(r, fieldName)}</li>)}</ul>}
    </div>
  );
}

export function RulesCard() {
  const { toast } = useApp();
  const names = useNames();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [runs, setRuns] = useState<RuleRun[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [shown, setShown] = useState<Record<string, RuleRun>>({});
  const load = useCallback(async () => {
    try {
      const [r, l] = await Promise.all([api.get<{ rules: Rule[] }>('/rules'), api.get<{ runs: RuleRun[] }>('/rules/runs')]);
      setRules(r.rules);
      setRuns(l.runs);
    } catch (e: any) {
      toast(`Couldn't load rules: ${e.message}`, 'error');
    }
  }, [toast]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const again = () => void load();
    window.addEventListener(RULES_CHANGED, again);
    return () => window.removeEventListener(RULES_CHANGED, again);
  }, [load]);
  if (!rules) return null;

  const save = async (next: Rule[]): Promise<boolean> => {
    try {
      setRules((await api.put<{ rules: Rule[] }>('/rules', { rules: next })).rules);
      names.reload();
      return true;
    } catch (e: any) {
      toast(e.message, 'error');
      return false;
    }
  };
  const act = async (r: Rule, dry: boolean) => {
    try {
      const run = dry ? await api.post<RuleRun>('/rules/preview', { rule: r }) : await api.post<RuleRun>(`/rules/${r.id}/run`, {});
      setShown((s) => ({ ...s, [r.id]: run }));
      if (!dry) {
        toast(run.error ? `"${r.name}" didn't run: ${run.error}` : `"${r.name}" ran on ${run.matched} lead${run.matched === 1 ? '' : 's'}`, run.error ? 'error' : undefined);
        await load();
      }
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const addStarter = (i: string) => {
    const s = STARTER_RULES[Number(i)];
    if (s) setEditing({ ...s, id: newKey() });
  };

  return (
    <div className="card" id="rules">
      <h2>Rules</h2>
      <p className="help">
        Every rule is <b>when X, do Y</b>. X is anything the CRM notices: a time of day, a call saved, a tag put on or taken off, a lead
        coming into or leaving a smart list, a condition turning true, leads imported, the call list running out, or you pressing Run now.
        Y is one or more steps, top to bottom, with Waits between them if you like. You can narrow which leads it does Y to with any Leads
        filter (set it here, or on Leads with <b>Make a rule</b>); a rule set off by one lead's change acts on just that lead, if it fits.
        Rules can set off other rules; one set off again for the same lead stops there, and the log says so. <b>Preview</b> shows what a
        rule would do now without changing anything, <b>Run now</b> runs it, and every run is in the log below.
      </p>
      <p className="help">
        Running out of calls is one of these "when"s. The list runs out when you've called every lead on it (or it's empty); then the rules
        for it go in the order listed here and the first one that adds leads wins, so together they set the order you call in (like imports,
        then yesterday's no-shows, then today's no-answers). A lead you already called from the list comes back only with a rule that has
        <b> Not dialed in the last …</b>, once that time is up, so the one you just called doesn't come straight back. It's checked every
        minute, and the Calling screen says what's next while you wait.
      </p>
      {rules.length === 0 && <p className="muted">No rules yet.</p>}
      <ul className="rule-list">
        {rules.map((r, i) => (
          <li key={r.id} className="rule" aria-label={`Rule ${r.name}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              {r.made_by ? <b>{r.name}</b> : (
                <label className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={r.enabled} aria-label={`${r.name} on`} onChange={(e) => void save(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} />
                  <b>{r.name}</b>{!r.enabled && <span className="muted">(off)</span>}
                </label>
              )}
              <span className="row" style={{ gap: 4 }}>
                <button className="btn small" onClick={() => void act(r, true)}>Preview</button>
                <button className="btn small" onClick={() => void act(r, false)} title="Run it now, whatever its trigger">Run now</button>
                {!r.made_by && <button className="btn small" aria-label={`Move ${r.name} up`} title="Rules for when the call list runs out go in this order" disabled={i === 0 || !!rules[i - 1]?.made_by} onClick={() => void save(swap(rules, i, i - 1))}>↑</button>}
                {!r.made_by && <button className="btn small" aria-label={`Move ${r.name} down`} title="Rules for when the call list runs out go in this order" disabled={!rules[i + 1] || !!rules[i + 1]?.made_by} onClick={() => void save(swap(rules, i, i + 1))}>↓</button>}
                {!r.made_by && <button className="btn small" onClick={() => setEditing(r)}>Edit</button>}
                <button className="btn small" title="Start a new rule from this one" onClick={() => setEditing({ ...r, made_by: undefined, id: newKey(), name: `${r.name} (copy)`.slice(0, 80) })}>Copy</button>
                {!r.made_by && <button className="btn small" onClick={() => { if (window.confirm(`Delete the rule "${r.name}"? Its log stays.`)) void save(rules.filter((x) => x.id !== r.id)); }}>Delete</button>}
              </span>
            </div>
            {r.made_by && <div className="help" style={{ margin: '2px 0 0' }}>{madeByText(r)}</div>}
            {/* The rule as a chain, read top to bottom: when, for which leads, then each step. */}
            <ol className="rule-chain" aria-label={`Steps of ${r.name}`}>
              <li className="when"><b>When</b> {describeTrigger(r.trigger, names.outcomeLabel, names.statusName)}</li>
              <li className="if"><b>For leads</b> {describeFilter(r.filter, { tag: names.tagName, field: names.fieldName, status: names.statusName })}</li>
              {r.actions.map((a, j) => (
                <li key={j} className={a.kind === 'wait' ? 'wait' : 'do'}>
                  {a.kind === 'wait' ? <><b>Wait</b> {describeWait(a.after)}</> : <><b>Do</b> {describeAction(a, names.fieldName)}</>}
                </li>
              ))}
            </ol>
            {shown[r.id] && (
              <div className="rule-result" aria-label={`${shown[r.id]!.dry_run ? 'Preview' : 'Run'} of ${r.name}`}>
                <b>{shown[r.id]!.dry_run ? 'Preview (nothing changed)' : 'Just ran'}:</b> <RunSummary run={shown[r.id]!} fieldName={names.fieldName} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="btn" onClick={() => setEditing({ id: newKey(), name: '', enabled: true, trigger: { kind: 'daily', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] }, filter: { status: 'all' }, actions: [{ kind: 'add_to_list' }] })}>
          + New rule
        </button>
        <select aria-label="Add a ready-made rule" value="" onChange={(e) => addStarter(e.target.value)}>
          <option value="">+ Ready-made rule…</option>
          {STARTER_RULES.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
        </select>
      </div>
      <details style={{ marginTop: 10 }}>
        <summary>Log: what rules did ({runs.length})</summary>
        {runs.length === 0 ? <p className="muted">Nothing yet. Runs that matched no leads aren't listed.</p> : (
          <ul className="history" aria-label="Rules log">
            {runs.map((run) => (
              <li key={run.id}>
                <span className="muted">{fmtDateTime(run.at)}</span> <b>{run.rule_name}</b> <span className="muted">({RUN_TRIGGER[run.trigger] ?? run.trigger})</span>
                <RunSummary run={run} fieldName={names.fieldName} />
              </li>
            ))}
          </ul>
        )}
      </details>
      {editing && (
        <RuleEditor
          rule={editing}
          isNew={!rules.some((r) => r.id === editing.id)}
          onCancel={() => setEditing(null)}
          onSave={async (r) => {
            const next = rules.some((x) => x.id === r.id) ? rules.map((x) => (x.id === r.id ? r : x)) : [...rules, r];
            if (await save(next)) {
              setEditing(null);
              toast(`Saved "${r.name}"${r.enabled ? '' : ' (off)'}`);
            }
          }}
        />
      )}
    </div>
  );
}

/** Makes a new rule from the Leads filters: opens the editor, then adds it to your rules. */
export function NewRuleFromFilters({ filter, onClose }: { filter: Filter; onClose: () => void }) {
  const { toast } = useApp();
  const [rule] = useState<Rule>(() => ({ id: newKey(), name: '', enabled: true, trigger: { kind: 'daily', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] }, filter, actions: [{ kind: 'add_to_list' }] }));
  return (
    <RuleEditor
      rule={rule}
      isNew
      onCancel={onClose}
      onSave={async (r) => {
        try {
          const { rules } = await api.get<{ rules: Rule[] }>('/rules');
          await api.put('/rules', { rules: [...rules, r] });
          toast(`Saved "${r.name}". See it in Automation → Rules.`);
          onClose();
        } catch (e: any) {
          toast(e.message, 'error');
        }
      }}
    />
  );
}

/** A come-back plan typed as "15m, 1d@09:00, 3d": kept as you type, used once every step is understood. */
function StepsInput({ steps, label, onChange }: { steps: string[]; label: string; onChange: (steps: string[]) => void }) {
  const [text, setText] = useState(steps.join(', '));
  const ok = parsePlan(text);
  return (
    <span className="row" style={{ gap: 4 }}>
      after
      <input value={text} aria-label={label} placeholder="15m, 1d@09:00, 3d" style={{ width: 200 }}
        onChange={(e) => { setText(e.target.value); const p = parsePlan(e.target.value); if (p?.length) onChange(p); }} />
      {(!ok || !ok.length) && <span className="error">write each step like 15m, 2h, 3d or 1d@09:00</span>}
      <span className="help">each step from then, or from the last try nobody answered</span>
    </span>
  );
}

/** How long a Wait step waits: one step, like 2h or 1d@09:00. */
function WaitInput({ after, label, onChange }: { after: string; label: string; onChange: (after: string) => void }) {
  const [text, setText] = useState(after);
  const ok = isStep(text.trim().toLowerCase());
  return (
    <span className="row" style={{ gap: 4 }}>
      <input value={text} aria-label={label} placeholder="2h" style={{ width: 100 }}
        onChange={(e) => { setText(e.target.value); const v = e.target.value.trim().toLowerCase(); if (isStep(v)) onChange(v); }} />
      {ok ? <span className="help">{describeWait(text.trim().toLowerCase())}, then the steps below</span> : <span className="error">write it like 15m, 2h, 3d or 1d@09:00</span>}
    </span>
  );
}

const emptyAction = (kind: RuleAction['kind'], firstField: string | undefined, firstCounter: string | undefined): RuleAction => {
  switch (kind) {
    case 'add_tag':
    case 'remove_tag': return { kind, tag: '' };
    case 'set_field': return { kind, field_id: firstField ?? '', value: '' };
    case 'mark_dead': return { kind, reason: '' };
    case 'counter': return { kind, field_id: firstCounter ?? '', op: 'add', by: 1 };
    case 'come_back': return { kind, steps: ['1d@09:00'] };
    case 'wait': return { kind, after: '1d@09:00' };
    default: return { kind };
  }
};

const emptyTrigger = (kind: RuleTrigger['kind'], firstStatus: string | undefined): RuleTrigger => {
  switch (kind) {
    case 'daily': return { kind, time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] };
    case 'call_saved': return { kind, outcomes: [] };
    case 'tag_added':
    case 'tag_removed': return { kind, tag: '' };
    case 'status': return { kind, status_id: firstStatus ?? '', when: 'enters' };
    case 'becomes_true': return { kind, condition: '' };
    case 'manual':
    case 'imported':
    case 'list_empty': return { kind };
  }
};

function RuleEditor(props: { rule: Rule; isNew: boolean; onSave: (r: Rule) => Promise<void>; onCancel: () => void }) {
  const { meta, toast } = useApp();
  const names = useNames();
  // A formula field is worked out, so a rule can't set it; a counter has its own action.
  const settable = names.fields.filter((f) => f.type !== 'formula' && f.type !== 'counter');
  const counters = names.fields.filter((f) => f.type === 'counter');
  /** Which condition is open in the editor: the trigger's, or the filters' "only if". */
  const [conditionFor, setConditionFor] = useState<'trigger' | 'filter' | null>(null);
  const [r, setR] = useState<Rule>(props.rule);
  const [preview, setPreview] = useState<RuleRun | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Rule>) => { setR({ ...r, ...patch }); setPreview(null); };
  // The Python view: its text, and its mistake while it has one (the rule keeps the last text that read right).
  const [text, setText] = useState<{ src: string; error: { line: number; message: string } | null } | null>(null);
  const ruleNames: RuleNames = {
    tag: names.tagName, tagId: (n) => names.tags.find((t) => t.name.toLowerCase() === n.toLowerCase())?.id,
    field: names.fieldName, fieldId: (n) => names.fields.find((f) => f.label.toLowerCase() === n.toLowerCase())?.id,
    status: names.statusName, statusId: (n) => names.statuses.find((st) => st.name.toLowerCase() === n.toLowerCase())?.id,
  };
  const toText = () => setText({ src: ruleToPython(r, ruleNames), error: null });
  const toForm = () => { if (!text?.error) setText(null); };
  const readText = (src: string) => {
    try {
      set(pythonToRule(src, r, ruleNames));
      setText({ src, error: null });
    } catch (e) {
      if (!(e instanceof RuleTextError)) throw e;
      setText({ src, error: { line: e.line, message: e.message } });
    }
  };
  const setFilter = (key: keyof Filter, v: unknown) => {
    const f: Record<string, unknown> = { ...r.filter, [key]: v };
    if (v === '' || v == null) delete f[key];
    set({ filter: f as Filter });
  };
  const setTrigger = (t: RuleTrigger) => set({ trigger: t });
  const setAction = (i: number, a: RuleAction) => set({ actions: r.actions.map((x, j) => (j === i ? a : x)) });
  const outcomes = meta?.outcome_codes ?? [];
  const runPreview = async () => {
    try {
      setPreview(await api.post<RuleRun>('/rules/preview', { rule: { ...r, name: r.name || 'New rule' } }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  // Appointment day: one choice for the two kept forms (a named range, or a number of days ago).
  const apptValue = r.filter.appt_days ? `k:${r.filter.appt_days}` : r.filter.appt_days_ago != null ? `n:${r.filter.appt_days_ago}` : '';
  const setAppt = (v: string) => {
    const f: Record<string, unknown> = { ...r.filter };
    delete f.appt_days;
    delete f.appt_days_ago;
    if (v.startsWith('k:')) f.appt_days = v.slice(2);
    if (v.startsWith('n:')) f.appt_days_ago = Number(v.slice(2));
    set({ filter: f as Filter });
  };
  const listValue = r.filter.on_list === '1' || r.filter.on_list === true ? 'on' : r.filter.not_on_list === '1' || r.filter.not_on_list === true ? 'off' : '';
  const setList = (v: string) => {
    const f: Record<string, unknown> = { ...r.filter };
    delete f.on_list;
    delete f.not_on_list;
    if (v === 'on') f.on_list = '1';
    if (v === 'off') f.not_on_list = '1';
    set({ filter: f as Filter });
  };

  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), props.onCancel())}>
      <form
        className="modal"
        style={{ width: 'min(760px, 100%)' }}
        role="dialog"
        aria-label={props.isNew ? 'New rule' : 'Edit rule'}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await props.onSave({ ...r, name: r.name.trim() });
          } finally {
            setBusy(false);
          }
        }}
      >
        <header><b>{props.isNew ? 'New rule' : `Edit "${props.rule.name}"`}</b><button type="button" className="btn small" onClick={props.onCancel}>Close <kbd>Esc</kbd></button></header>
        <div className="body rule-editor">
          <div className="row" style={{ gap: 8 }}>
            <div className="tabs small" role="tablist" aria-label="Rule view">
              <button type="button" role="tab" aria-selected={!text} className={!text ? 'active' : ''} onClick={toForm} disabled={!!text?.error}>Form</button>
              <button type="button" role="tab" aria-selected={!!text} className={text ? 'active' : ''} onClick={toText}>Python</button>
            </div>
            {text?.error && <span className="error" role="alert" aria-label="Python mistake">Line {text.error.line}: {text.error.message}</span>}
          </div>
          {text ? (
            <label className="field">
              <span className="help" style={{ margin: 0 }}>
                The same rule as Python: <code>@when(...)</code> says when it runs, <code>@leads(...)</code> which leads, the docstring is its name, an{' '}
                <code>if</code> is its condition, and each line under it is an action: <code>add_tag</code>, <code>remove_tag</code>, <code>add_to_list</code>,{' '}
                <code>remove_from_list</code>, <code>set_field</code>, <code>counter</code>, <code>mark_dead</code>, <code>come_back("15m", "1d@09:00")</code>. Add <code>@off</code> to save it switched off.
              </span>
              <textarea value={text.src} rows={Math.max(8, text.src.split('\n').length + 2)} spellCheck={false} style={{ width: '100%', fontFamily: 'var(--mono, monospace)' }} aria-label="Rule in Python" onChange={(e) => readText(e.target.value)} />
            </label>
          ) : (<>
          <label className="field">
            <span>Name</span>
            <input autoFocus value={r.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} aria-label="Rule name" placeholder="e.g. Yesterday's no-shows onto the list" />
          </label>

          <fieldset>
            <legend>When</legend>
            <select value={r.trigger.kind} aria-label="When" onChange={(e) => setTrigger(emptyTrigger(e.target.value as RuleTrigger['kind'], names.statuses[0]?.id))}>
              {(Object.keys(TRIGGER_LABELS) as RuleTrigger['kind'][]).map((k) => <option key={k} value={k}>{TRIGGER_LABELS[k]}</option>)}
            </select>
            {r.trigger.kind === 'daily' && (() => {
              const t = r.trigger;
              return (
                <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                  <label className="row" style={{ gap: 4 }}>at <input type="time" value={t.time} aria-label="Time" onChange={(e) => setTrigger({ ...t, time: e.target.value || '08:00' })} /></label>
                  {WEEKDAYS.map((d, i) => (
                    <label key={d} className="row" style={{ gap: 2 }}>
                      <input type="checkbox" checked={t.days.includes(i)} onChange={(e) => setTrigger({ ...t, days: e.target.checked ? [...t.days, i].sort() : t.days.filter((x) => x !== i) })} /> {d}
                    </label>
                  ))}
                  <span className="help" style={{ margin: 0 }}>If the app is closed then, it runs when you next open it that day.</span>
                </div>
              );
            })()}
            {r.trigger.kind === 'call_saved' && (() => {
              const t = r.trigger;
              return (
                <div style={{ marginTop: 6 }}>
                  <span className="help">With any of these outcomes (none ticked: any outcome). It acts on that call's lead, if it fits the filters below.</span>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                    {outcomes.map((o) => (
                      <label key={o.code} className="row" style={{ gap: 2 }}>
                        <input type="checkbox" checked={t.outcomes.includes(o.code)} onChange={(e) => setTrigger({ ...t, outcomes: e.target.checked ? [...t.outcomes, o.code] : t.outcomes.filter((x) => x !== o.code) })} /> {o.label}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })()}
            {(r.trigger.kind === 'tag_added' || r.trigger.kind === 'tag_removed') && (() => {
              const t = r.trigger;
              return (
                <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <input list="rule-tag-names" value={t.tag} maxLength={40} placeholder="Tag name" aria-label="Trigger tag" onChange={(e) => setTrigger({ ...t, tag: e.target.value })} />
                  <span className="help" style={{ margin: 0 }}>By anything: you, a rule, an import. It acts on that lead, if it fits the filters below.</span>
                </div>
              );
            })()}
            {r.trigger.kind === 'status' && (() => {
              const t = r.trigger;
              return (
                <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <select value={t.when} aria-label="Enters or leaves" onChange={(e) => setTrigger({ ...t, when: e.target.value as 'enters' | 'leaves' })}>
                    <option value="enters">comes into</option>
                    <option value="leaves">leaves</option>
                  </select>
                  <select value={t.status_id} aria-label="Smart list" onChange={(e) => setTrigger({ ...t, status_id: e.target.value })}>
                    {!names.statuses.some((st) => st.id === t.status_id) && <option value={t.status_id}>{t.status_id ? 'A deleted smart list' : 'Pick a smart list'}</option>}
                    {names.statuses.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                  </select>
                  {!names.statuses.length && <span className="help" style={{ margin: 0 }}>Make a smart list first, in Automation → Smart lists.</span>}
                </div>
              );
            })()}
            {r.trigger.kind === 'becomes_true' && (() => {
              const t = r.trigger;
              return (
                <div style={{ marginTop: 6 }}>
                  <div className="row" style={{ gap: 6 }}>
                    {t.condition ? <code aria-label="Trigger condition">{t.condition}</code> : <span className="muted">No condition yet.</span>}
                    <button type="button" className="btn small" onClick={() => setConditionFor('trigger')}>{t.condition ? 'Edit' : 'Write it…'}</button>
                  </div>
                  <span className="help">Checked after each change and every minute. It fires when the condition goes from false to true for a lead.</span>
                  <label className="row" style={{ gap: 4 }}>
                    <input type="checkbox" checked={!!t.already} onChange={(e) => setTrigger({ ...t, already: e.target.checked || undefined })} /> Also for leads it's already true for when I save
                  </label>
                  {conditionFor === 'trigger' && (
                    <ConditionEditor value={t.condition} onApply={(c) => { setTrigger({ ...t, condition: c }); setConditionFor(null); }} onCancel={() => setConditionFor(null)} />
                  )}
                </div>
              );
            })()}
            <datalist id="rule-tag-names">{names.tags.map((t) => <option key={t.id} value={t.name} />)}</datalist>
          </fieldset>

          <fieldset>
            <legend>For leads like these</legend>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <select value={r.filter.status ?? 'all'} aria-label="Leads tab" onChange={(e) => setFilter('status', e.target.value)}>
                {LEAD_TABS.map((t) => <option key={t.key} value={t.key}>{t.key === 'all' ? 'All leads' : t.label}</option>)}
              </select>
              <select value={apptValue} aria-label="Appointment" onChange={(e) => setAppt(e.target.value)}>
                <option value="">Appointment any day</option>
                {[0, 1, 2, 3, 4, 5, 6, 7, 14].map((n) => <option key={n} value={`n:${n}`}>{n === 0 ? 'Appointment today' : n === 1 ? 'Appointment yesterday' : `Appointment ${n} days ago`}</option>)}
                {APPT_DAYS.filter((d) => d.key !== 'yesterday').map((d) => <option key={d.key} value={`k:${d.key}`}>{d.label}</option>)}
              </select>
              <select value={r.filter.last_call ?? ''} aria-label="Last call" onChange={(e) => setFilter('last_call', e.target.value)}>
                <option value="">Last call: any time</option>
                {LAST_CALL.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <select value={listValue} aria-label="Call list" onChange={(e) => setList(e.target.value)}>
                <option value="">On the call list or not</option>
                <option value="on">Waiting on the call list</option>
                <option value="off">Not on the call list</option>
              </select>
              <select value={r.filter.tag ?? ''} aria-label="Tag" onChange={(e) => setFilter('tag', e.target.value)}>
                <option value="">Any tags</option>
                {names.tags.map((t) => <option key={t.id} value={t.id}>Tagged {t.name}</option>)}
                <option value="none">No tags</option>
              </select>
              <button type="button" className="btn small" onClick={() => setConditionFor('filter')}>{r.filter.where ? 'Edit the condition' : 'Condition…'}</button>
              {r.filter.where && <button type="button" className="btn small" aria-label="Remove the filter condition" onClick={() => setFilter('where', '')}>× condition</button>}
            </div>
            {conditionFor === 'filter' && (
              <ConditionEditor value={r.filter.where ?? ''} onApply={(c) => { setFilter('where', c); setConditionFor(null); }} onCancel={() => setConditionFor(null)} />
            )}
            <p className="help" style={{ marginBottom: 0 }}>
              {describeFilter(r.filter, { tag: names.tagName, field: names.fieldName, status: names.statusName })}. For other filters (county, lead type, your fields…), set them on Leads and use <b>Make a rule</b>.
            </p>
          </fieldset>

          <fieldset>
            <legend>Do this</legend>
            <p className="help" style={{ marginTop: 0 }}>Top to bottom. A Wait holds the steps after it for each lead, then does them (the leads that waited get them, whether or not they still match).</p>
            {r.actions.map((a, i) => (
              <div key={i} className="row" style={{ gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                <span className="muted">{i + 1}.</span>
                <select value={a.kind} aria-label={`Action ${i + 1}`} onChange={(e) => setAction(i, emptyAction(e.target.value as RuleAction['kind'], settable[0]?.id, counters[0]?.id))}>
                  {(Object.keys(ACTION_LABELS) as RuleAction['kind'][])
                    .filter((k) => (k !== 'set_field' || settable.length) && (k !== 'counter' || counters.length || a.kind === 'counter'))
                    .map((k) => <option key={k} value={k}>{ACTION_LABELS[k]}</option>)}
                </select>
                {(a.kind === 'add_tag' || a.kind === 'remove_tag') && (
                  <input list="rule-tag-names" value={a.tag} maxLength={40} placeholder="Tag name" aria-label={`Action ${i + 1} tag`} onChange={(e) => setAction(i, { ...a, tag: e.target.value })} />
                )}
                {a.kind === 'counter' && (
                  <>
                    <select value={a.field_id} aria-label={`Action ${i + 1} counter`} onChange={(e) => setAction(i, { ...a, field_id: e.target.value })}>
                      {!counters.some((x) => x.id === a.field_id) && <option value={a.field_id}>A deleted counter</option>}
                      {counters.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                    <select value={a.op} aria-label={`Action ${i + 1} add or set`} onChange={(e) => setAction(i, { ...a, op: e.target.value as 'add' | 'set' })}>
                      <option value="add">add</option>
                      <option value="set">set to</option>
                    </select>
                    <input type="number" step={1} value={a.by} style={{ width: 80 }} aria-label={`Action ${i + 1} number`} onChange={(e) => setAction(i, { ...a, by: Math.trunc(Number(e.target.value) || 0) })} />
                    <span className="help" style={{ margin: 0 }}>{a.op === 'add' ? 'A minus number takes off.' : 'Set to 0 to reset it.'}</span>
                  </>
                )}
                {a.kind === 'set_field' && (() => {
                  const f = settable.find((x) => x.id === a.field_id);
                  return (
                    <>
                      <select value={a.field_id} aria-label={`Action ${i + 1} field`} onChange={(e) => setAction(i, { ...a, field_id: e.target.value, value: '' })}>
                        {!f && <option value={a.field_id}>A deleted field</option>}
                        {settable.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                      </select>
                      to {f && <CustomFieldInput field={f} value={a.value} onChange={(v) => setAction(i, { ...a, value: v })} ariaLabel={`Action ${i + 1} value`} blank="(blank)" />}
                    </>
                  );
                })()}
                {a.kind === 'come_back' && <StepsInput steps={a.steps} label={`Action ${i + 1} steps`} onChange={(steps) => setAction(i, { ...a, steps })} />}
                {a.kind === 'wait' && <WaitInput after={a.after} label={`Action ${i + 1} wait`} onChange={(after) => setAction(i, { ...a, after })} />}
                {a.kind === 'mark_dead' && (
                  <input value={a.reason ?? ''} maxLength={200} placeholder={`Reason (default: Rule: ${r.name || 'its name'})`} aria-label={`Action ${i + 1} reason`} onChange={(e) => setAction(i, { ...a, reason: e.target.value })} style={{ minWidth: 240 }} />
                )}
                {r.actions.length > 1 && <button type="button" className="btn small" aria-label={`Remove action ${i + 1}`} onClick={() => set({ actions: r.actions.filter((_, j) => j !== i) })}>✕</button>}
              </div>
            ))}
            {r.actions.length < 10 && <button type="button" className="btn small" onClick={() => set({ actions: [...r.actions, { kind: 'add_tag', tag: '' }] })}>+ Another action</button>}
          </fieldset>

          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> On
          </label>
          </>)}

          {preview && (
            <div className="rule-result" aria-label="Preview">
              <b>If it ran now (nothing changed):</b> <RunSummary run={preview} fieldName={names.fieldName} />
            </div>
          )}
          <div className="row">
            <button type="submit" className="btn primary" disabled={busy || !r.name.trim() || !!text?.error}>Save rule</button>
            <button type="button" className="btn" onClick={() => void runPreview()}>Preview</button>
            <button type="button" className="btn" onClick={props.onCancel}>Cancel</button>
          </div>
        </div>
      </form>
    </div>
  );
}
