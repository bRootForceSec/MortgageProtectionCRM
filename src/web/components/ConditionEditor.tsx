import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { useTags } from '../tags';
import { useCustomFields } from '../customFields';
import { useStatuses } from '../statuses';
import { FORMULA_VALUES, FormulaError } from '../../shared/formula';
import { CMP_OPS, emptyGroup, toForm, toPython, type CmpOp, type CondGroup, type CondItem, type CondTerm, type Literal } from '../../shared/condition';
import { isNumericField } from '../../shared/customFields';

// A condition, edited two ways: as a form (groups of rows) or as Python. Both edit the same text, and you can switch
// any time. Anything the rows don't cover shows as a Python row, so the form never loses part of a condition.

interface Check {
  error: string | null;
  at: number | null;
  matched: number;
  total: number;
}

export function ConditionEditor({ value, onApply, onCancel }: { value: string; onApply: (python: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(value);
  // A condition the form can't read (a mistake in it) opens as Python.
  const [first] = useState<CondGroup | null>(() => {
    try {
      return toForm(value);
    } catch {
      return null;
    }
  });
  const [view, setView] = useState<'form' | 'python'>(first ? 'form' : 'python');
  const [group, setGroup] = useState<CondGroup>(first ?? emptyGroup());
  const python = view === 'form' ? toPython(group) : text;
  const [check, setCheck] = useState<Check | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.post<Check>('/conditions/check', { condition: python }).then(
        (c) => { if (live) { setCheck(c); setFailed(null); } },
        (e: Error) => { if (live) setFailed(e.message); },
      );
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [python]);

  const toPythonView = () => {
    setText(toPython(group));
    setView('python');
  };
  const [formError, setFormError] = useState<string | null>(null);
  const toFormView = () => {
    try {
      setGroup(toForm(text));
      setFormError(null);
      setView('form');
    } catch (e) {
      setFormError(e instanceof FormulaError ? `Fix this first: ${e.message}` : (e as Error).message);
    }
  };

  return (
    <div className="card condition-editor" role="group" aria-label="Condition">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <div className="tabs small" role="tablist" aria-label="Condition view">
          <button type="button" role="tab" aria-selected={view === 'form'} className={view === 'form' ? 'active' : ''} onClick={() => view !== 'form' && toFormView()}>Form</button>
          <button type="button" role="tab" aria-selected={view === 'python'} className={view === 'python' ? 'active' : ''} onClick={() => view !== 'python' && toPythonView()}>Python</button>
        </div>
        <span className="muted" aria-label="Condition matches">
          {failed ? `Couldn't check it: ${failed}` : check?.error ? <span className="error">{check.error}</span> : check ? `Matches ${check.matched} of ${check.total} leads` : 'Checking…'}
        </span>
      </div>
      {formError && <p className="error">{formError}</p>}
      {view === 'form' ? (
        <GroupEditor g={group} onChange={setGroup} top />
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Condition in Python"
            rows={4}
            spellCheck={false}
            style={{ width: '100%', fontFamily: 'var(--mono, monospace)' }}
            placeholder={'has("No show") and hours_since(added("No show")) < 72'}
          />
          <p className="help">
            Python: <code>and</code>, <code>or</code>, <code>not</code>, <code>==</code>, <code>x if test else y</code>, <code>field("Name")</code>, and the
            formula values and functions (Settings → Your fields lists them). <code>has("Tag")</code>, <code>added("Tag")</code>, <code>times("Tag", days=7)</code>,{' '}
            <code>before("A", "B")</code> and <code>pressed("Outcome")</code> read each lead's history.
          </p>
        </>
      )}
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn small primary" disabled={!!check?.error} onClick={() => onApply(python === 'True' ? '' : python)}>Use this condition</button>
        <button type="button" className="btn small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const GROUP_MODES = [
  { key: 'all', label: 'All of these', mode: 'all', negate: false },
  { key: 'any', label: 'Any of these', mode: 'any', negate: false },
  { key: 'none', label: 'None of these', mode: 'any', negate: true },
  { key: 'not_all', label: 'Not all of these', mode: 'all', negate: true },
] as const;

function GroupEditor({ g, onChange, onRemove, top }: { g: CondGroup; onChange: (g: CondGroup) => void; onRemove?: () => void; top?: boolean }) {
  const modeKey = GROUP_MODES.find((m) => m.mode === g.mode && m.negate === g.negate)!.key;
  const set = (i: number, item: CondItem) => onChange({ ...g, items: g.items.map((x, j) => (j === i ? item : x)) });
  const remove = (i: number) => onChange({ ...g, items: g.items.filter((_, j) => j !== i) });
  return (
    <div className={top ? 'cond-group' : 'cond-group nested'}>
      <div className="row" style={{ gap: 6 }}>
        <select
          value={modeKey}
          aria-label="Match"
          onChange={(e) => {
            const m = GROUP_MODES.find((x) => x.key === e.target.value)!;
            onChange({ ...g, mode: m.mode, negate: m.negate });
          }}
        >
          {GROUP_MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
        {onRemove && <button type="button" className="btn small" onClick={onRemove} aria-label="Remove group">Remove group</button>}
      </div>
      {g.items.length === 0 && <p className="muted">No rows yet: every lead matches.</p>}
      {g.items.map((item, i) =>
        item.kind === 'group'
          ? <GroupEditor key={i} g={item} onChange={(x) => set(i, x)} onRemove={() => remove(i)} />
          : <TermEditor key={i} t={item} onChange={(x) => set(i, x)} onRemove={() => remove(i)} />,
      )}
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn small" onClick={() => onChange({ ...g, items: [...g.items, { kind: 'has', tag: '', negate: false }] })}>+ Row</button>
        <button type="button" className="btn small" onClick={() => onChange({ ...g, items: [...g.items, { kind: 'group', mode: 'any', negate: false, items: [] }] })}>+ Group</button>
      </div>
    </div>
  );
}

const TERM_KINDS: { kind: CondTerm['kind']; label: string }[] = [
  { kind: 'has', label: 'Has tag' },
  { kind: 'status', label: 'In a status' },
  { kind: 'times', label: 'Times a tag was put on' },
  { kind: 'since', label: 'Time since a tag was put on or taken off' },
  { kind: 'before', label: 'One tag put on before another' },
  { kind: 'pressed', label: 'Calls saved with an outcome' },
  { kind: 'value', label: 'A lead value' },
  { kind: 'field', label: 'One of your fields' },
  { kind: 'python', label: 'Python' },
];

function blankTerm(kind: CondTerm['kind']): CondTerm {
  switch (kind) {
    case 'has': return { kind, tag: '', negate: false };
    case 'status': return { kind, name: '', negate: false };
    case 'times': return { kind, tag: '', days: null, op: '>=', n: 1 };
    case 'since': return { kind, tag: '', event: 'added', unit: 'days', op: '<=', n: 1 };
    case 'before': return { kind, first: '', second: '' };
    case 'pressed': return { kind, outcome: '', days: null, op: '>=', n: 1 };
    case 'value': return { kind, name: 'attempts', op: '>=', value: 1 };
    case 'field': return { kind, label: '', op: '==', value: '' };
    case 'python': return { kind, code: '' };
  }
}

function TermEditor({ t, onChange, onRemove }: { t: CondTerm; onChange: (t: CondTerm) => void; onRemove: () => void }) {
  const { meta } = useApp();
  const { tags } = useTags();
  const { fields } = useCustomFields();
  const outcomes = useMemo(() => (meta?.outcome_codes ?? []).map((o) => o.label), [meta]);
  const tagNames = tags.map((x) => x.name);
  const statusNames = useStatuses().statuses.map((x) => x.name);
  const tagPick = (v: string, set: (v: string) => void, label: string) => <Pick value={v} options={tagNames} onChange={set} label={label} placeholder="tag" />;
  const opPick = (op: CmpOp, set: (op: CmpOp) => void) => (
    <select value={op} onChange={(e) => set(e.target.value as CmpOp)} aria-label="Compare">
      {CMP_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
    </select>
  );
  const numBox = (n: number, set: (n: number) => void, label: string) => (
    <input type="number" value={n} onChange={(e) => set(Number(e.target.value) || 0)} aria-label={label} style={{ width: 70 }} />
  );
  const daysBox = (days: number | null, set: (d: number | null) => void) => (
    <label className="row" style={{ gap: 4 }}>
      in the last
      <input type="number" min={1} value={days ?? ''} placeholder="any" onChange={(e) => set(e.target.value ? Math.max(1, Number(e.target.value)) : null)} aria-label="In the last days" style={{ width: 60 }} />
      days
    </label>
  );
  let body: ReactNode;
  switch (t.kind) {
    case 'has':
      body = (
        <>
          <select value={t.negate ? 'not' : 'has'} onChange={(e) => onChange({ ...t, negate: e.target.value === 'not' })} aria-label="Has or not">
            <option value="has">has tag</option>
            <option value="not">doesn't have tag</option>
          </select>
          {tagPick(t.tag, (tag) => onChange({ ...t, tag }), 'Tag')}
        </>
      );
      break;
    case 'status':
      body = (
        <>
          <select value={t.negate ? 'not' : 'in'} onChange={(e) => onChange({ ...t, negate: e.target.value === 'not' })} aria-label="In or not">
            <option value="in">is in status</option>
            <option value="not">isn't in status</option>
          </select>
          <Pick value={t.name} options={statusNames} onChange={(name) => onChange({ ...t, name })} label="Status" placeholder="status" />
        </>
      );
      break;
    case 'times':
      body = <>{tagPick(t.tag, (tag) => onChange({ ...t, tag }), 'Tag')} put on {opPick(t.op, (op) => onChange({ ...t, op }))} {numBox(t.n, (n) => onChange({ ...t, n }), 'Times')} times {daysBox(t.days, (days) => onChange({ ...t, days }))}</>;
      break;
    case 'since':
      body = (
        <>
          <select value={t.unit} onChange={(e) => onChange({ ...t, unit: e.target.value as 'days' | 'hours' })} aria-label="Unit">
            <option value="days">Days</option>
            <option value="hours">Hours</option>
          </select>
          since
          {tagPick(t.tag, (tag) => onChange({ ...t, tag }), 'Tag')}
          <select value={t.event} onChange={(e) => onChange({ ...t, event: e.target.value as 'added' | 'removed' })} aria-label="Put on or taken off">
            <option value="added">was put on</option>
            <option value="removed">was taken off</option>
          </select>
          {opPick(t.op, (op) => onChange({ ...t, op }))} {numBox(t.n, (n) => onChange({ ...t, n }), 'Amount')}
        </>
      );
      break;
    case 'before':
      body = <>{tagPick(t.first, (first) => onChange({ ...t, first }), 'First tag')} was last put on before {tagPick(t.second, (second) => onChange({ ...t, second }), 'Second tag')}</>;
      break;
    case 'pressed':
      body = (
        <>
          calls saved as <Pick value={t.outcome} options={outcomes} onChange={(outcome) => onChange({ ...t, outcome })} label="Outcome" placeholder="outcome" />
          {opPick(t.op, (op) => onChange({ ...t, op }))} {numBox(t.n, (n) => onChange({ ...t, n }), 'Calls')} {daysBox(t.days, (days) => onChange({ ...t, days }))}
        </>
      );
      break;
    case 'value': {
      const def = FORMULA_VALUES.find((v) => v.name === t.name);
      body = (
        <>
          <select value={t.name} onChange={(e) => onChange({ ...t, name: e.target.value })} aria-label="Value" title={def?.help}>
            {FORMULA_VALUES.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
          {opPick(t.op, (op) => onChange({ ...t, op }))}
          <LiteralBox value={t.value} kind={def?.kind ?? 'text'} onChange={(value) => onChange({ ...t, value })} />
        </>
      );
      break;
    }
    case 'field': {
      const f = fields.find((x) => x.label.toLowerCase() === t.label.toLowerCase());
      const kind = !f ? 'text' : f.type === 'yes_no' || (f.type === 'formula' && f.result === 'yes_no') ? 'yes_no' : isNumericField(f) ? 'number' : 'text';
      body = (
        <>
          <select value={f?.label ?? t.label} onChange={(e) => onChange({ ...t, label: e.target.value })} aria-label="Field">
            {!f && <option value={t.label}>{t.label || 'pick a field'}</option>}
            {fields.map((x) => <option key={x.id} value={x.label}>{x.label}</option>)}
          </select>
          {opPick(t.op, (op) => onChange({ ...t, op }))}
          <LiteralBox value={t.value} kind={kind} onChange={(value) => onChange({ ...t, value })} />
        </>
      );
      break;
    }
    case 'python':
      body = <input value={t.code} onChange={(e) => onChange({ ...t, code: e.target.value })} aria-label="Python" placeholder='attempts * 2 > age / 10' spellCheck={false} style={{ flex: 1, minWidth: 260, fontFamily: 'var(--mono, monospace)' }} />;
      break;
  }
  return (
    <div className="row cond-row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <select value={t.kind} onChange={(e) => onChange(blankTerm(e.target.value as CondTerm['kind']))} aria-label="Row kind">
        {TERM_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
      </select>
      {body}
      <button type="button" className="btn small" onClick={onRemove} aria-label="Remove row" title="Remove this row">×</button>
    </div>
  );
}

/** A text box with suggestions (tags, outcomes); you can type a name that isn't there yet. */
function Pick({ value, options, onChange, label, placeholder }: { value: string; options: string[]; onChange: (v: string) => void; label: string; placeholder: string }) {
  const id = useId();
  return (
    <>
      <input list={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder={placeholder} style={{ width: 150 }} />
      <datalist id={id}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}

function LiteralBox({ value, kind, onChange }: { value: Literal; kind: 'number' | 'text' | 'yes_no' | 'date'; onChange: (v: Literal) => void }) {
  if (kind === 'yes_no') {
    return (
      <select value={value === true ? 'yes' : 'no'} onChange={(e) => onChange(e.target.value === 'yes')} aria-label="Value is">
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  }
  if (kind === 'number') return <input type="number" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(Number(e.target.value) || 0)} aria-label="Value is" style={{ width: 90 }} />;
  return <input value={String(value)} onChange={(e) => onChange(e.target.value)} aria-label="Value is" style={{ width: 140 }} />;
}
