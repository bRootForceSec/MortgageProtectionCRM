import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime, fmtPhone, fullName, type LeadDetail } from '../api';
import { useApp } from '../App';
import { LeadSummary, CallHistory, Notes, StatusBadge } from '../components/LeadView';

const STATUSES = [
  { key: 'all', label: 'All' }, { key: 'new', label: 'New' }, { key: 'retry', label: 'Retry' }, { key: 'callback', label: 'Callbacks' },
  { key: 'appointment_set', label: 'Appointments' }, { key: 'invalid', label: 'Invalid' }, { key: 'dead', label: 'Dead pile' },
];

export function LeadsPage() {
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => api.get<any[]>('/leads', { status, search }).then(setRows), [status, search]);
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
        <input placeholder="Search name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="muted">{rows.length}{rows.length === 500 ? '+' : ''} lead(s)</span>
      </div>
      <table className="grid">
        <thead><tr><th>Name</th><th>Phone</th><th>Location</th><th>Batch</th><th>Status</th><th>Attempts</th><th>Last call</th><th>Last outcome</th><th>Next</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
              <td>{fullName(r)}</td><td>{fmtPhone(r.phone_e164)}</td><td>{[r.city, r.state].filter(Boolean).join(', ')}</td>
              <td>{r.batch_name}</td><td><StatusBadge status={r.status} /></td><td>{r.attempts_total}</td>
              <td>{fmtDateTime(r.last_call_at)}</td><td>{r.last_outcome_code ?? ''}</td><td>{fmtDateTime(r.next_due_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty">No leads here.</div>}
      {open && <LeadModal id={open} onClose={() => { setOpen(null); void load(); }} />}
    </>
  );
}

export function LeadModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { toast } = useApp();
  const [d, setD] = useState<LeadDetail | null>(null);
  const load = useCallback(() => api.get<LeadDetail>(`/leads/${id}`).then(setD).catch((e) => toast(e.message, 'error')), [id, toast]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const act = async (action: 'mark_dead' | 'restore') => {
    const reason = action === 'mark_dead' ? window.prompt('Reason for moving to the dead pile (optional):') : 'restored from lead page';
    if (reason === null) return;
    await api.post(`/leads/${id}/actions`, { action, reason });
    toast(action === 'mark_dead' ? 'Moved to dead pile' : 'Restored to queue');
    await load();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header>
          <b>Lead</b>
          <div className="row">
            {d && (d.state?.status === 'dead' || d.state?.status === 'invalid'
              ? <button className="btn small" onClick={() => act('restore')}>Restore to queue</button>
              : <button className="btn small danger" onClick={() => act('mark_dead')}>Move to dead pile</button>)}
            <button className="btn small" onClick={onClose}>Close <kbd>Esc</kbd></button>
          </div>
        </header>
        <div className="body">
          {d && (
            <>
              <LeadSummary d={d} />
              <h3>Calls</h3>
              <CallHistory calls={d.calls} onChange={load} />
              <h3 style={{ marginTop: 14 }}>Notes</h3>
              <Notes d={d} onChange={load} />
              {d.actions.length > 0 && (
                <>
                  <h3 style={{ marginTop: 14 }}>Lead actions</h3>
                  <ul className="history">
                    {d.actions.map((a) => <li key={a.id}>{fmtDateTime(a.created_at)} · {a.action.replace('_', ' ')}{a.reason ? ` · ${a.reason}` : ''}</li>)}
                  </ul>
                </>
              )}
              <p className="help">Source: batch "{d.batch.name}", row {d.import_row?.row_number} of {d.batch.file_name}. Imported {fmtDateTime(d.batch.imported_at)}.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
