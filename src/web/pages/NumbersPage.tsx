import { Fragment, useEffect, useState } from 'react';
import { api, fmtDateTime, fmtPhone, type CallerNumber } from '../api';
import { useApp } from '../App';
import { todayRange } from '../components/CallbackAlerts';

// The numbers you call from: how each is doing, and the reputation checks you do by hand.
// The app never switches numbers by itself.

interface Stats {
  id: string;
  calls_today: number; dials_today: number; calls_7d: number; dials_7d: number; contacts_7d: number;
  calls_30d: number; dials_30d: number; appointments: number; open_appointments: number; contact_rate_7d: number | null;
}
interface Check { item: string; label: string; checked_on: string | null; result: 'ok' | 'problem' | null; note: string | null }

function Checklist({ n }: { n: CallerNumber }) {
  const { toast } = useApp();
  const [items, setItems] = useState<Check[]>([]);
  useEffect(() => void api.get<Check[]>(`/numbers/${n.id}/checks`).then(setItems), [n.id]);
  const save = async (c: Check, patch: Partial<Check>) => {
    try {
      const next = { ...c, ...patch };
      setItems(await api.post<Check[]>(`/numbers/${n.id}/checks`, { item: c.item, checked_on: next.checked_on || null, result: next.result, note: next.note }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return (
    <table className="grid checklist" aria-label={`Reputation checklist for ${n.label ?? n.e164}`}>
      <thead><tr><th>Check</th><th>Date done</th><th>Result</th><th>Note</th></tr></thead>
      <tbody>
        {items.map((c) => (
          <tr key={c.item}>
            <td>{c.label}</td>
            <td className="nowrap">
              <input type="date" value={c.checked_on ?? ''} onChange={(e) => save(c, { checked_on: e.target.value || null })} aria-label={`Date for ${c.label}`} />
              {!c.checked_on && <button className="btn small" onClick={() => save(c, { checked_on: ymd, result: 'ok' })}>Done today</button>}
            </td>
            <td>
              <select value={c.result ?? ''} disabled={!c.checked_on} onChange={(e) => save(c, { result: (e.target.value || null) as Check['result'] })} aria-label={`Result for ${c.label}`}>
                <option value="">–</option><option value="ok">OK</option><option value="problem">Problem</option>
              </select>
            </td>
            <td><input defaultValue={c.note ?? ''} placeholder="optional" onBlur={(e) => e.target.value !== (c.note ?? '') && save(c, { note: e.target.value })} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function NumbersPage() {
  const { meta, reloadMeta, toast } = useApp();
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [stats, setStats] = useState<Map<string, Stats>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api.get<Stats[]>('/numbers/stats', { today_from: todayRange().from }).then((r) => setStats(new Map(r.map((x) => [x.id, x])))).catch(() => {});
  }, [meta?.numbers]);

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
        <p className="help">List the numbers you call from (for now, your Sideline number). Each logged call records which one you used. Nothing here buys, switches or changes a number with a provider. "Checklist" keeps the dates of the reputation checks you do by hand.</p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field"><span>Number</span><input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="(614) 555-0199" /></label>
          <label className="field"><span>Label</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sideline" /></label>
          <button className="btn primary" onClick={add} disabled={!number.trim()}>Add number</button>
        </div>
      </div>
      <table className="grid">
        <thead><tr><th>Label</th><th>Number</th><th>Today calls / dials</th><th>7 days calls / dials</th><th>Pick-up rate, 7 days</th><th>30 days calls / dials</th><th>Appointments set</th><th>Status</th><th>Reputation (manual)</th><th>Added</th><th></th></tr></thead>
        <tbody>
          {meta?.numbers.map((n) => {
            const st = stats.get(n.id);
            return (
            <Fragment key={n.id}>
            <tr>
              <td>{n.label}</td>
              <td>{fmtPhone(n.e164)}</td>
              <td>{st ? `${st.calls_today} / ${st.dials_today}` : ''}</td>
              <td>{st ? `${st.calls_7d} / ${st.dials_7d}` : ''}</td>
              <td>{st?.contact_rate_7d != null ? `${Math.round(st.contact_rate_7d * 100)}%` : '–'}</td>
              <td>{st ? `${st.calls_30d} / ${st.dials_30d}` : ''}</td>
              <td>{st?.appointments ?? ''}{st && st.open_appointments > 0 && <div className="muted small">{st.open_appointments} still coming up</div>}</td>
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
                    const openAppts = st?.open_appointments ?? 0;
                    if (openAppts && !window.confirm(`${openAppts} appointment(s) still coming up were set from this number. Those leads may call it back. Retire it anyway?`)) return;
                    const reason = window.prompt('Why retire this number? (history is kept)');
                    if (reason !== null) void update(n, { status: 'retired', retire_reason: reason });
                  }}>Retire</button>
                )}
                <button className="btn small" onClick={() => setOpen(open === n.id ? null : n.id)} aria-expanded={open === n.id}>Checklist</button>
                {n.retire_reason && n.status === 'retired' && <div className="muted small">{n.retire_reason}</div>}
              </td>
            </tr>
            {open === n.id && (
              <tr><td colSpan={11}><Checklist n={n} /></td></tr>
            )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
      {meta?.numbers.length === 0 && <div className="empty">No numbers yet.</div>}
    </>
  );
}
