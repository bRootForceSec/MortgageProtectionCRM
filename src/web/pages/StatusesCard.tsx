import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { useStatuses } from '../statuses';
import { ConditionEditor } from '../components/ConditionEditor';
import { STATUS_COLORS, type Status, type StatusBadge, type StatusInfo } from '../../shared/statuses';

// Automation → Smart lists: your statuses are names for conditions. A lead is in every status whose condition is true for
// it, so it can be in many at once. Each shows as a badge in your order; tick "Leads tab" to filter Leads by it.

const strip = ({ leads: _l, error: _e, ...st }: StatusInfo): Status => st;

export function StatusesCard() {
  const { toast } = useApp();
  const { statuses, setStatuses } = useStatuses();
  /** The status whose condition is open in the editor ('new' for one being added). */
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const save = async (next: Status[], done?: string) => {
    try {
      setStatuses(await api.put<StatusInfo[]>('/statuses', next));
      if (done) toast(done);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };
  const all = statuses.map(strip);
  const change = (id: string, patch: Partial<Status>) => {
    // Show the change at once; the save brings back the counts (or the old values, if it fails).
    const before = statuses;
    setStatuses(statuses.map((st) => (st.id === id ? { ...st, ...patch } : st)));
    void save(all.map((st) => (st.id === id ? { ...st, ...patch } : st))).then((ok) => { if (!ok) setStatuses(before); });
  };
  const move = (i: number, by: number) => {
    const next = [...all];
    const [st] = next.splice(i, 1);
    next.splice(i + by, 0, st!);
    void save(next);
  };
  const remove = (st: StatusInfo) => {
    if (!window.confirm(`Delete the status "${st.name}"? Leads aren't changed; it just stops showing.`)) return;
    void save(all.filter((x) => x.id !== st.id), `Deleted "${st.name}"`);
  };

  return (
    <div className="card" id="statuses">
      <h2>Statuses</h2>
      <p className="help">
        A status is a name for a condition, like "Needs rebook" for leads with a no-show and no new appointment. A lead is in every status whose condition is
        true for it, so it can be in several at once, and it moves in and out by itself as its tags and calls change. Statuses show as badges on leads, in this
        order. Tick "Leads tab" to see a status as a tab on Leads. A condition can use another status: <code>status("Needs rebook")</code>.
      </p>
      {statuses.length > 0 && (
        <table className="grid">
          <thead><tr><th>Status</th><th>Color</th><th>Leads tab</th><th>Condition</th><th>Leads</th><th></th></tr></thead>
          <tbody>
            {statuses.map((st, i) => (
              <tr key={st.id}>
                <td>
                  <input defaultValue={st.name} key={st.name} maxLength={40} aria-label={`Name of status ${st.name}`}
                    onBlur={(e) => { const name = e.target.value.trim(); if (name && name !== st.name) change(st.id, { name }); }} />
                </td>
                <td>
                  <select value={st.color} aria-label={`Color of ${st.name}`} onChange={(e) => change(st.id, { color: e.target.value as Status['color'] })}>
                    {STATUS_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td><input type="checkbox" checked={st.tab} aria-label={`${st.name} as a Leads tab`} onChange={(e) => change(st.id, { tab: e.target.checked })} /></td>
                <td>
                  {st.error ? <span className="error">{st.error}</span> : <code>{st.condition}</code>}{' '}
                  <button className="btn small" onClick={() => setEditing(st.id)} aria-label={`Edit the condition of ${st.name}`}>Edit</button>
                  {editing === st.id && (
                    <ConditionEditor
                      value={st.condition}
                      onApply={async (condition) => { if (await save(all.map((x) => (x.id === st.id ? { ...x, condition: condition || 'True' } : x)))) setEditing(null); }}
                      onCancel={() => setEditing(null)}
                    />
                  )}
                </td>
                <td>{st.leads ?? '–'}</td>
                <td className="nowrap">
                  <button className="btn small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${st.name} up`}>↑</button>
                  <button className="btn small" disabled={i === statuses.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${st.name} down`}>↓</button>{' '}
                  <button className="btn small" onClick={() => remove(st)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing === 'new' ? (
        <div>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name, like Needs rebook" aria-label="New status name" maxLength={40} />
          <ConditionEditor
            value=""
            onApply={async (condition) => {
              const ok = await save([...all, { id: crypto.randomUUID(), name: newName.trim(), condition: condition || 'True', color: 'blue', tab: false }], `Status "${newName.trim()}" added`);
              if (ok) { setEditing(null); setNewName(''); }
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : (
        <button className="btn small" onClick={() => setEditing('new')}>+ Status</button>
      )}
    </div>
  );
}

/** A lead's statuses as colored badges, in your order. */
export function StatusChips({ statuses }: { statuses: StatusBadge[] | undefined }) {
  if (!statuses?.length) return null;
  return <>{statuses.map((st) => <span key={st.id} className={`status-chip c-${st.color}`} title="Your status">{st.name}</span>)}</>;
}
