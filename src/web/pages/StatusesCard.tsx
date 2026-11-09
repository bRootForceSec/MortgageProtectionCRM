import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { useStatuses } from '../statuses';
import { ConditionEditor } from '../components/ConditionEditor';
import { namesIn } from '../../shared/formula';
import { LIST_FUNCTIONS, STATUS_COLORS, type Status, type StatusBadge, type StatusInfo } from '../../shared/statuses';

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
    if (!window.confirm(`Delete the smart list "${st.name}"? Leads aren't changed; it just stops showing.`)) return;
    void save(all.filter((x) => x.id !== st.id), `Deleted "${st.name}"`);
  };

  return (
    <div className="card" id="statuses">
      <h2>Smart lists</h2>
      <p className="help">
        A smart list is a name for a condition, like "Needs rebook" for leads tagged No show with no new appointment. A lead is in every smart list whose
        condition is true for it, so it can be in several at once, and it moves in and out by itself as its tags and calls change. Smart lists show as badges on
        leads, in this order. Tick "Leads tab" to see one as a tab on Leads. A smart list can use another one: <code>in_list("Needs rebook")</code>. Anywhere
        you pick leads (who can be called, rules, the funnel), you can pick a smart list instead of writing the condition again.
      </p>
      {statuses.length > 0 && (
        <table className="grid">
          <thead><tr><th>Smart list</th><th>Color</th><th>Leads tab</th><th>Condition</th><th>Leads</th><th></th></tr></thead>
          <tbody>
            {statuses.map((st, i) => (
              <tr key={st.id}>
                <td>
                  <input defaultValue={st.name} key={st.name} maxLength={40} aria-label={`Name of smart list ${st.name}`}
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
                  <ListLinks st={st} all={statuses} />
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
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name, like Needs rebook" aria-label="New smart list name" maxLength={40} />
          <ConditionEditor
            value=""
            onApply={async (condition) => {
              const ok = await save([...all, { id: crypto.randomUUID(), name: newName.trim(), condition: condition || 'True', color: 'blue', tab: false }], `Smart list "${newName.trim()}" added`);
              if (ok) { setEditing(null); setNewName(''); }
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : (
        <button className="btn small" onClick={() => setEditing('new')}>+ Smart list</button>
      )}
    </div>
  );
}

/** A lead's smart lists as colored badges, in your order. */
/** Which of your smart lists this one uses (in_list), and which use it. */
function ListLinks({ st, all }: { st: Status; all: Status[] }) {
  const uses = (x: Status) => namesIn(x.condition, LIST_FUNCTIONS).map((n) => n.toLowerCase());
  const used = new Set(uses(st));
  const names = all.filter((x) => x.id !== st.id && used.has(x.name.toLowerCase())).map((x) => x.name);
  const by = all.filter((x) => x.id !== st.id && uses(x).includes(st.name.toLowerCase())).map((x) => x.name);
  if (!names.length && !by.length) return null;
  return (
    <div className="muted small" aria-label={`Lists ${st.name} uses`}>
      {names.length > 0 && <>Uses {names.join(', ')}</>}
      {names.length > 0 && by.length > 0 && ' · '}
      {by.length > 0 && <>Used by {by.join(', ')}</>}
    </div>
  );
}

export function StatusChips({ statuses }: { statuses: StatusBadge[] | undefined }) {
  if (!statuses?.length) return null;
  return <>{statuses.map((st) => <span key={st.id} className={`status-chip c-${st.color}`} title="Your smart list">{st.name}</span>)}</>;
}
