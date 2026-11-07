import { useEffect, useState } from 'react';
import { api, newKey } from '../api';
import { useApp } from '../App';
import { STEP_ORDERS, describeFilter, type Routine, type StepOrder } from '../../shared/routines';
import type { LeadQuery } from '../../shared/leadFilter';
import { useTags } from '../tags';
import { useStatuses } from '../statuses';
import { useCustomFields } from '../customFields';

// Leads → "Save as routine step": keeps the filters you set as a step at the end of a routine. Relative choices
// (last call today, imported today, appointment yesterday) stay relative, so the step means the same thing every day.

export function SaveStepDialog(props: { filter: Partial<LeadQuery>; onClose: () => void }) {
  const { toast } = useApp();
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [routineId, setRoutineId] = useState('');
  const [name, setName] = useState('');
  const [order, setOrder] = useState<StepOrder>('set');
  const [busy, setBusy] = useState(false);
  const { tagName } = useTags();
  const { fieldName } = useCustomFields();
  const { statusName } = useStatuses();
  useEffect(() => {
    api.get<{ routines: Routine[] }>('/routines')
      .then((r) => {
        setRoutines(r.routines);
        setRoutineId(r.routines[0]?.id ?? '');
      })
      .catch((e: Error) => toast(`Couldn't load routines: ${e.message}`, 'error'));
  }, [toast]);

  const save = async () => {
    if (!routines || !name.trim()) return;
    setBusy(true);
    try {
      const step = { id: newKey(), name: name.trim(), order, source: { kind: 'filter' as const, filter: props.filter } };
      const next = routineId
        ? routines.map((r) => (r.id === routineId ? { ...r, steps: [...r.steps, step] } : r))
        : [...routines, { id: newKey(), name: 'Every day', days: [0, 1, 2, 3, 4, 5, 6], steps: [step] }];
      await api.put('/routines', { routines: next });
      toast(`"${step.name}" added to ${routines.find((r) => r.id === routineId)?.name ?? 'a new routine'}`);
      props.onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), props.onClose())}>
      <form className="modal small-modal" role="dialog" aria-label="Save as routine step" onSubmit={(e) => (e.preventDefault(), void save())}>
        <header><b>Save as routine step</b></header>
        <div className="body">
          <p className="help" style={{ marginTop: 0 }}>{describeFilter(props.filter, { tag: tagName, field: fieldName, status: statusName })}</p>
          <label className="field">
            <span>Step name</span>
            <input aria-label="Step name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Yesterday's sat no sale" />
          </label>
          <label className="field">
            <span>Routine</span>
            <select aria-label="Routine" value={routineId} onChange={(e) => setRoutineId(e.target.value)}>
              {routines?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              {routines && !routines.length && <option value="">A new routine, every day</option>}
            </select>
          </label>
          <label className="field">
            <span>Order</span>
            <select aria-label="Order" value={order} onChange={(e) => setOrder(e.target.value as StepOrder)}>
              {Object.entries(STEP_ORDERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <p className="help">It goes at the end of the routine. Move it in Settings → Calling → Routines.</p>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !routines || !name.trim()}>Save step</button>
            <button className="btn" type="button" onClick={props.onClose}>Cancel</button>
          </div>
        </div>
      </form>
    </div>
  );
}
