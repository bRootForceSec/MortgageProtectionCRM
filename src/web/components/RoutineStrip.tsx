import { useCallback, useEffect, useState } from 'react';
import { api, type AddResult } from '../api';
import { useApp } from '../App';
import { getStored, setStored } from '../storage';
import { StartStepDialog, type CurrentList } from './CallListDialogs';
import { UnmarkedAppointments } from './UnmarkedAppointments';
import { LeadViewer } from './LeadViewer';
import type { RoutineToday, StepOrder, StepToday } from '../../shared/routines';

// Today's routine above the call list: each step with what it has to call (or how far you got), any of them a click
// away, and the next one offered when the list runs out. Set routines up in Settings → Calling.

const MODE_KEY = 'mpcrm.routine.mode';

function stepDone(s: StepToday): boolean {
  return !!s.started_at && s.called >= s.total;
}

export function RoutineStrip(props: {
  current: CurrentList;
  defaultName: string;
  /** Nothing left to call on the list. */
  listDone: boolean;
  /** Changes whenever the list does, so the counts follow your calls. */
  refreshKey: string;
  onStarted: (order: StepOrder, mode: 'add' | 'replace') => Promise<void>;
}) {
  const { toast, go, reportAdded } = useApp();
  const [today, setToday] = useState<RoutineToday | null>(null);
  const [starting, setStarting] = useState<StepToday | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const load = useCallback(
    () => api.get<RoutineToday>('/routine/today').then(setToday).catch((e: Error) => toast(`Couldn't load today's routine: ${e.message}`, 'error')),
    [toast],
  );
  useEffect(() => void load(), [load, props.refreshKey]);

  if (!today || !today.choices.length) return null;

  const choose = async (id: string) => {
    try {
      setToday(await api.post<RoutineToday>('/routine/today', { routine_id: id }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const start = async (step: StepToday, mode: 'add' | 'replace', saveCurrentAs: string | null) => {
    try {
      const r = await api.post<AddResult & { order: StepOrder }>(`/routine/steps/${step.id}/start`, { mode, save_current_as: saveCurrentAs });
      setStored(MODE_KEY, mode);
      reportAdded(r, `${step.name}: ${r.added} lead${r.added === 1 ? '' : 's'} ${mode === 'replace' ? 'on the call list' : 'added to the call list'}`);
      setStarting(null);
      await props.onStarted(r.order, mode);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  // The first step you haven't started today that has leads to call. Empty ones are passed over: no no-shows today,
  // or no-answers that haven't come round yet (they fill in as the day goes, and come up then).
  const next = today.steps.find((s) => !s.started_at && !!s.count) ?? null;
  const allStarted = today.steps.length > 0 && today.steps.every((s) => s.started_at);

  return (
    <div className="routine" aria-label="Today's routine">
      <div className="routine-steps">
        {today.choices.length > 1 || !today.routine ? (
          <select aria-label="Routine for today" value={today.routine?.id ?? ''} onChange={(e) => void choose(e.target.value)}>
            {!today.routine && <option value="">No routine today</option>}
            {today.choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.today ? '' : ' (not set for today)'}</option>)}
          </select>
        ) : (
          <b className="routine-name">{today.routine.name}</b>
        )}
        {today.steps.map((s, i) => {
          const done = stepDone(s);
          const label = s.count == null ? 'list gone' : s.started_at ? `${s.called}/${s.total} called${s.count ? ` · ${s.count} new` : ''}` : String(s.count);
          return (
            <button
              key={s.id}
              className={`routine-step ${done ? 'done' : s.started_at ? 'started' : ''} ${next?.id === s.id ? 'next' : ''}`}
              onClick={() => (s.count == null ? go('settings') : setStarting(s))}
              title={s.count == null ? 'The saved list for this step is gone. Pick another in Settings → Calling.' : s.started_at ? 'Started today. Click to add any new matches.' : 'Start this step'}
            >
              {done ? '✓' : `${i + 1}.`} {s.name} <span className="muted">{label}</span>
            </button>
          );
        })}
        {today.routine && !today.steps.length && <span className="muted">No steps yet. Add them in Settings → Calling.</span>}
      </div>
      {props.listDone && today.routine && (
        next ? (
          <div className="list-done" role="status">
            <span>Next: <b>{next.name}</b> ({next.count} to call)</span>
            <button className="btn small primary" onClick={() => setStarting(next)}>Start</button>
          </div>
        ) : allStarted ? (
          <div className="list-done" role="status"><b>Routine done for today.</b></div>
        ) : (
          <div className="list-done" role="status">Nothing else in today's routine to call right now. Steps fill in as the day goes.</div>
        )
      )}
      {starting && (
        <StartStepDialog
          name={starting.name}
          count={starting.count ?? 0}
          mode={getStored(MODE_KEY) === 'replace' ? 'replace' : 'add'}
          current={props.current}
          defaultName={props.defaultName}
          extra={starting.appt_days ? <UnmarkedAppointments days={starting.appt_days} onOpen={setViewing} onChecked={() => void load()} /> : undefined}
          onStart={(mode, saveAs) => start(starting, mode, saveAs)}
          onCancel={() => setStarting(null)}
        />
      )}
      {viewing && <LeadViewer id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
