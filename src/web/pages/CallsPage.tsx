import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtPhone } from '../api';
import { useApp } from '../App';
import { LeadModal } from './LeadsPage';

function dayRange(dateStr: string) {
  const start = new Date(`${dateStr}T00:00:00`);
  return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
}

export function CallsPage() {
  const { meta } = useApp();
  const today = new Date();
  const [day, setDay] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
  const [outcome, setOutcome] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const label = (c: string | null) => meta?.outcome_codes.find((o) => o.code === c)?.label ?? c ?? 'no outcome';

  useEffect(() => {
    api.get<any[]>('/calls', { ...dayRange(day), outcome: outcome || undefined }).then(setRows);
  }, [day, outcome, open]);

  const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.outcome_code ?? 'none'] = (m[r.outcome_code ?? 'none'] ?? 0) + 1), m), {});

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="field"><span>Day</span><input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
        <label className="field"><span>Outcome</span>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">All</option>
            {meta?.outcome_codes.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </select>
        </label>
        <span className="muted">{rows.length} call(s)</span>
        <a className="btn small" href="/api/export/calls.csv" style={{ marginLeft: 'auto' }}>Export all calls (CSV)</a>
      </div>
      {!outcome && rows.length > 0 && (
        <div className="summary-tiles">
          {Object.entries(counts).map(([k, n]) => <div key={k}><b>{n}</b>{label(k === 'none' ? null : k)}</div>)}
        </div>
      )}
      <table className="grid">
        <thead><tr><th>Time</th><th>Lead</th><th>To</th><th>Caller ID</th><th>Outcome</th><th>Talk</th><th>Source</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="click" onClick={() => r.lead_id && setOpen(r.lead_id)}>
              <td>{fmtDateTime(r.requested_at)}</td><td>{r.lead_name}</td><td>{fmtPhone(r.to_e164)}</td>
              <td>{r.from_label ?? ''} {fmtPhone(r.from_e164)}</td><td>{label(r.outcome_code)}</td>
              <td>{r.talk_seconds != null ? `${Math.round(r.talk_seconds / 60)} min` : ''}</td>
              <td className="muted">{r.channel === 'manual_log' ? 'logged by hand' : r.channel}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty">No calls on this day.</div>}
      {open && <LeadModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
