import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { describeFunnelCount, FUNNEL_STEPS, STARTER_FUNNEL, type FunnelCount, type FunnelStep, type FunnelStepDef } from '../../shared/funnel';
import { STATUS_COLORS, type StatusColor } from '../../shared/statuses';
import { useTags } from '../tags';
import { useStatuses } from '../statuses';

// Automation: your funnel steps, top to bottom. The top bar and the funnel graphic show them in this order.
// Each counts one of the seven things the CRM keeps itself, a tag, a smart list, or a formula of yours over the log in the period.

/** A text box that saves when you leave it; blank puts the old text back. */
function TextField({ value, label, onSave, wide }: { value: string; label: string; onSave: (v: string) => void; wide?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => (v.trim() && v.trim() !== value ? onSave(v.trim()) : setV(value));
  return <input aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} style={wide ? { flex: 1, minWidth: 200 } : { width: 140 }} />;
}

export function FunnelStepsCard() {
  const { toast, bumpStats } = useApp();
  const [steps, setSteps] = useState<FunnelStepDef[] | null>(null);
  const { tags } = useTags();
  const { statuses } = useStatuses();
  useEffect(() => {
    api.get<FunnelStepDef[]>('/funnel/steps').then(setSteps).catch((e: Error) => toast(`Couldn't load your funnel steps: ${e.message}`, 'error'));
  }, [toast]);
  if (!steps) return null;
  const save = async (next: FunnelStepDef[]) => {
    const before = steps;
    setSteps(next);
    try {
      setSteps(await api.put<FunnelStepDef[]>('/funnel/steps', next));
      bumpStats();
    } catch (e) {
      toast((e as Error).message, 'error');
      setSteps(before);
    }
  };
  const put = (i: number, patch: Partial<FunnelStepDef>) => void save(steps.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    void save(next);
  };
  const countOf = (v: string, was: FunnelCount): FunnelCount => {
    if (v === 'tag') return { by: 'tag', tag: tags[0]?.name ?? 'Hot' };
    if (v === 'list') return { by: 'list', list: statuses[0]?.name ?? 'Hot' };
    if (v === 'formula') return { by: 'formula', formula: was.by === 'formula' ? was.formula : 'times("Hot")' };
    return { by: 'measure', measure: v as FunnelStep };
  };
  /** What the Counts menu shows: one the CRM keeps, or a tag, a smart list or a formula. */
  const kindOf = (c: FunnelCount) => (c.by === 'measure' ? c.measure : c.by);
  const same = JSON.stringify(steps) === JSON.stringify(STARTER_FUNNEL);
  return (
    <div className="card" id="funnel-steps">
      <h2>Funnel</h2>
      <p className="help">
        Your funnel, top to bottom: the top bar shows these each day and the funnel button on the Calling screen draws them. A step counts one of the
        seven things the CRM keeps (dials, pickups and so on), a tag (each time it was put on in the period), a smart list (the leads in it now),
        or a formula of yours. Give a step a color for the funnel graphic; a smart list step takes the list's color unless you pick one. A formula that gives a number is added up over your leads, like{' '}
        <code>times("Hot")</code>; a yes/no counts the leads it's true for, like <code>pressed("Appt set") &gt; 0</code>. In a funnel step,{' '}
        <code>times</code>, <code>pressed</code>, <code>added</code>, <code>removed</code> and <code>before</code> only see the period being counted
        (today in the top bar).
      </p>
      <ol aria-label="Funnel steps" style={{ margin: 0, paddingLeft: 20 }}>
        {steps.map((st, i) => {
          const kind = kindOf(st.count);
          const c = st.count;
          return (
          <li key={st.id}>
            <span className="row" style={{ gap: 6 }}>
              <TextField label="Step name" value={st.name} onSave={(name) => put(i, { name })} />
              <select aria-label="Counts" value={kind} onChange={(e) => put(i, { count: countOf(e.target.value, st.count) })}>
                {FUNNEL_STEPS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                <option value="tag">A tag</option>
                <option value="list">A smart list</option>
                <option value="formula">A formula</option>
              </select>
              {c.by === 'tag' && (
                <select aria-label="Tag" value={c.tag} onChange={(e) => put(i, { count: { by: 'tag', tag: e.target.value } })}>
                  {!tags.some((t) => t.name === c.tag) && <option value={c.tag}>{c.tag}</option>}
                  {tags.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
              )}
              {c.by === 'list' && (
                <select aria-label="Smart list" value={c.list} onChange={(e) => put(i, { count: { by: 'list', list: e.target.value } })}>
                  {!statuses.some((x) => x.name === c.list) && <option value={c.list}>{c.list}</option>}
                  {statuses.map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}
                </select>
              )}
              {c.by === 'formula' && <TextField label="Formula" wide value={c.formula} onSave={(formula) => put(i, { count: { by: 'formula', formula } })} />}
              <select aria-label="Color" value={st.color ?? ''} onChange={(e) => put(i, { color: (e.target.value || undefined) as StatusColor | undefined })}>
                <option value="">Its own color</option>
                {STATUS_COLORS.map((c) => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}
              </select>
              <button type="button" className="btn small" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="btn small" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="btn small" aria-label="Remove step" disabled={steps.length === 1} onClick={() => void save(steps.filter((_, j) => j !== i))}>✕</button>
            </span>
            {kind !== 'formula' && <div className="help">{describeFunnelCount(st.count)}</div>}
          </li>
          );
        })}
      </ol>
      <span className="row" style={{ gap: 6, marginTop: 8 }}>
        {steps.length < 12 && (
          <button type="button" className="btn small" onClick={() => void save([...steps, { id: crypto.randomUUID(), name: 'New step', count: { by: 'formula', formula: 'times("Hot")' } }])}>
            Add a step
          </button>
        )}
        {!same && <button type="button" className="btn small" onClick={() => void save(STARTER_FUNNEL)}>Back to the start</button>}
      </span>
    </div>
  );
}
