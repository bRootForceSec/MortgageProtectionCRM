import { useCallback, useEffect, useState } from 'react';
import { api, newKey as newId, type CallListResponse, type SavedList } from '../api';
import { useApp } from '../App';
import { STARTER_STEPS, STEP_ORDERS, WEEKDAYS, describeFilter, type Routine, type RoutineStep, type StepOrder } from '../../shared/routines';

// Settings → Routines: the order you call in each day. A routine runs on the days you tick (like an alarm), and its
// steps are Leads filters or saved lists. Your own filter steps come from the Leads page ("Save as routine step").

/** A name field that saves when you leave it. */
function NameField({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => (v.trim() && v.trim() !== value ? onSave(v.trim()) : setV(value));
  return <input aria-label={label} value={v} maxLength={60} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

export function RoutinesCard() {
  const { toast } = useApp();
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [lists, setLists] = useState<SavedList[]>([]);
  const load = useCallback(async () => {
    try {
      const [r, l] = await Promise.all([api.get<{ routines: Routine[] }>('/routines'), api.get<CallListResponse>('/call-list')]);
      setRoutines(r.routines);
      setLists(l.saved_lists);
    } catch (e: any) {
      toast(`Couldn't load routines: ${e.message}`, 'error');
    }
  }, [toast]);
  useEffect(() => void load(), [load]);
  if (!routines) return null;

  const save = async (next: Routine[]) => {
    const before = routines;
    setRoutines(next);
    try {
      setRoutines((await api.put<{ routines: Routine[] }>('/routines', { routines: next })).routines);
    } catch (e: any) {
      toast(e.message, 'error');
      setRoutines(before);
    }
  };
  const change = (id: string, patch: Partial<Routine>) => save(routines.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const changeStep = (r: Routine, stepId: string, patch: Partial<RoutineStep>) =>
    change(r.id, { steps: r.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) });
  const move = (r: Routine, i: number, by: number) => {
    const steps = [...r.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(i + by, 0, s!);
    return change(r.id, { steps });
  };
  const addStep = (r: Routine, choice: string) => {
    if (!choice) return;
    const starter = choice.startsWith('starter:') ? STARTER_STEPS[Number(choice.slice(8))] : null;
    const list = choice.startsWith('list:') ? lists.find((l) => l.id === choice.slice(5)) : null;
    const step: RoutineStep | null = starter
      ? { ...starter, id: newId() }
      : list
        ? { id: newId(), name: list.name.slice(0, 60), order: 'set', source: { kind: 'saved_list', list_id: list.id } }
        : null;
    if (step) void change(r.id, { steps: [...r.steps, step] });
  };
  const describe = (s: RoutineStep) =>
    s.source.kind === 'filter' ? describeFilter(s.source.filter) : `Saved list "${lists.find((l) => l.id === (s.source as { list_id: string }).list_id)?.name ?? 'gone'}"`;

  return (
    <div className="card">
      <h3>Routines</h3>
      <p className="help">
        The order you call in each day. The Calling screen shows today's steps above the call list, and when the list runs out it offers the next one:
        added under the list, or in place of it. A routine runs on the days you tick; give a day its own routine by ticking it on only that one.
        To make your own step, set the filters on the Leads page and click <b>Save as routine step</b>.
      </p>
      {routines.map((r) => (
        <div key={r.id} className="routine-edit" aria-label={`Routine ${r.name}`}>
          <div className="row">
            <NameField value={r.name} label="Routine name" onSave={(name) => void change(r.id, { name })} />
            <span className="row" style={{ gap: 2 }} role="group" aria-label="Days">
              {WEEKDAYS.map((d, i) => {
                const on = r.days.includes(i);
                return (
                  <button
                    key={d}
                    className={`btn small ${on ? 'primary' : ''}`}
                    aria-pressed={on}
                    onClick={() => void change(r.id, { days: on ? r.days.filter((x) => x !== i) : [...r.days, i].sort() })}
                  >
                    {d}
                  </button>
                );
              })}
            </span>
            <button
              className="btn small"
              onClick={() => window.confirm(`Delete the routine "${r.name}"?`) && void save(routines.filter((x) => x.id !== r.id))}
            >
              Delete routine
            </button>
          </div>
          <ol className="routine-step-list">
            {r.steps.map((s, i) => (
              <li key={s.id}>
                <NameField value={s.name} label="Step name" onSave={(name) => void changeStep(r, s.id, { name })} />
                <select aria-label="Order" value={s.order} onChange={(e) => void changeStep(r, s.id, { order: e.target.value as StepOrder })}>
                  {Object.entries(STEP_ORDERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <span className="muted">{describe(s)}</span>
                <span className="row" style={{ gap: 2, marginLeft: 'auto' }}>
                  <button className="btn small" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => void move(r, i, -1)}>↑</button>
                  <button className="btn small" aria-label={`Move ${s.name} down`} disabled={i === r.steps.length - 1} onClick={() => void move(r, i, 1)}>↓</button>
                  <button className="btn small" aria-label={`Remove ${s.name}`} onClick={() => void change(r.id, { steps: r.steps.filter((x) => x.id !== s.id) })}>✕</button>
                </span>
              </li>
            ))}
          </ol>
          <select aria-label="Add a step" value="" onChange={(e) => addStep(r, e.target.value)}>
            <option value="">+ Add a step…</option>
            <optgroup label="Ready-made">
              {STARTER_STEPS.map((s, i) => <option key={s.name} value={`starter:${i}`}>{s.name}: {describeFilter(s.source.kind === 'filter' ? s.source.filter : {})}</option>)}
            </optgroup>
            {lists.length > 0 && (
              <optgroup label="A saved list">
                {lists.map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name}</option>)}
              </optgroup>
            )}
          </select>
        </div>
      ))}
      <button className="btn small" onClick={() => void save([...routines, { id: newId(), name: routines.length ? 'New routine' : 'Every day', days: [], steps: [] }])}>
        Add a routine
      </button>
    </div>
  );
}
