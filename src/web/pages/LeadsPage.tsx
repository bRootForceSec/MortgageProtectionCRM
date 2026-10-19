import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime, fmtPhone, fullName } from '../api';
import { StatusBadge } from '../components/LeadView';
import { LeadViewer } from '../components/LeadViewer';
import { GroupPicker, useGroups } from '../components/GroupPicker';

const STATUSES = [
  { key: 'all', label: 'All' }, { key: 'new', label: 'New' }, { key: 'retry', label: 'Retry' }, { key: 'callback', label: 'Callbacks' },
  { key: 'appointment_set', label: 'Appointment set' }, { key: 'invalid', label: 'Bad numbers' }, { key: 'dead', label: 'Dead pile' },
];

export function LeadsPage() {
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [groups, setGroups, groupParams] = useGroups();

  const load = useCallback(
    () => api.get<any[]>('/leads', { status, search, ...groupParams }).then(setRows),
    [status, search, groupParams.counties, groupParams.area_codes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="tabs">
          {STATUSES.map((s) => <button key={s.key} className={status === s.key ? 'active' : ''} onClick={() => setStatus(s.key)}>{s.label}</button>)}
        </div>
        <input placeholder="Search name, county, phone, or area code" value={search} onChange={(e) => setSearch(e.target.value)} title="A 3-digit number finds every county under that area code" />
        <GroupPicker groups={groups} onChange={setGroups} />
        <span className="muted">{rows.length}{rows.length === 500 ? '+' : ''} lead(s)</span>
      </div>
      <table className="grid">
        <thead><tr><th>Name</th><th>Phone</th><th>County</th><th>Location</th><th>Batch</th><th>Status</th><th>Attempts</th><th>Last call</th><th>Last outcome</th><th>Next</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
              <td>{fullName(r)}</td><td>{fmtPhone(r.phone_e164)}</td><td>{r.county ?? ''}</td><td>{[r.city, r.state].filter(Boolean).join(', ')}</td>
              <td>{r.batch_name}</td><td><StatusBadge status={r.status} /></td><td>{r.attempts_total}</td>
              <td>{fmtDateTime(r.last_call_at)}</td><td>{r.last_outcome_code ?? ''}</td><td>{fmtDateTime(r.next_due_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty">No leads here.</div>}
      {open && (
        <LeadViewer
          id={open}
          list={rows.map((r) => ({ id: r.id, name: fullName(r), status: r.status, phone: r.phone_e164, county: r.county }))}
          onClose={() => { setOpen(null); void load(); }}
        />
      )}
    </>
  );
}
