import { useState } from 'react';
import { api, fmtDateTime, fmtPhone, type CallerNumber } from '../api';
import { useApp } from '../App';

// Phase 1: a simple list of the numbers you call from, so each logged call records its caller ID.
// Buying numbers, reputation checks and appointment continuity come in Phases 2-3.

export function NumbersPage() {
  const { meta, reloadMeta, toast } = useApp();
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');

  const add = async () => {
    try {
      await api.post('/numbers', { number, label: label || null });
      setNumber('');
      setLabel('');
      await reloadMeta();
      toast('Number added');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const update = async (n: CallerNumber, patch: Record<string, unknown>) => {
    try {
      await api.post(`/numbers/${n.id}`, patch);
      await reloadMeta();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <div className="card">
        <h2>Your caller ID numbers</h2>
        <p className="help">List the numbers you call from (for now, your Sideline number). Each logged call records which one you used. Nothing here buys or changes a number with a provider.</p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field"><span>Number</span><input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="(614) 555-0199" /></label>
          <label className="field"><span>Label</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sideline" /></label>
          <button className="btn primary" onClick={add} disabled={!number.trim()}>Add number</button>
        </div>
      </div>
      <table className="grid">
        <thead><tr><th>Label</th><th>Number</th><th>Status</th><th>Reputation (manual)</th><th>Added</th><th></th></tr></thead>
        <tbody>
          {meta?.numbers.map((n) => (
            <tr key={n.id}>
              <td>{n.label}</td>
              <td>{fmtPhone(n.e164)}</td>
              <td>{n.status}{n.retired_at && <span className="muted"> {fmtDateTime(n.retired_at)}</span>}</td>
              <td>
                <select value={n.reputation_status} onChange={(e) => update(n, { reputation_status: e.target.value })} disabled={n.status === 'retired'}>
                  <option value="unchecked">Unchecked</option><option value="clear">Clear</option>
                  <option value="flagged">Flagged</option><option value="investigating">Investigating</option>
                </select>
                {n.reputation_updated_at && <span className="muted"> {fmtDateTime(n.reputation_updated_at)}</span>}
              </td>
              <td>{fmtDateTime(n.acquired_at)}</td>
              <td>
                {n.status === 'retired' ? (
                  <button className="btn small" onClick={() => update(n, { status: 'active' })}>Reactivate</button>
                ) : (
                  <button className="btn small danger" onClick={() => {
                    const reason = window.prompt('Why retire this number? (history is kept)');
                    if (reason !== null) void update(n, { status: 'retired', retire_reason: reason });
                  }}>Retire</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {meta?.numbers.length === 0 && <div className="empty">No numbers yet.</div>}
    </>
  );
}
