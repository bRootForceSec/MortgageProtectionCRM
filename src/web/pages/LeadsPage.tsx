import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime, fmtPhone, fullName, type AddResult } from '../api';
import { useApp } from '../App';
import { StatusBadge } from '../components/LeadView';
import { LeadViewer } from '../components/LeadViewer';
import { GroupPicker, useGroups } from '../components/GroupPicker';

// Where you pick who to call: filter the leads, tick the ones you want (or take every match),
// and add them to the bottom of the call list on the Calling page.

const STATUSES = [
  { key: 'all', label: 'All' }, { key: 'new', label: 'Never called' }, { key: 'retry', label: 'Tried' }, { key: 'callback', label: 'Callbacks' },
  { key: 'appointment_set', label: 'Appointment set' }, { key: 'invalid', label: 'Bad numbers' }, { key: 'dead', label: 'Dead pile' },
];

/** "Last tried more than … ago". */
const TRIED = [
  { key: '', label: 'Any time' },
  { key: '4h', label: 'Last tried 4+ hours ago', ms: 4 * 3600_000 },
  { key: '1d', label: 'Last tried 1+ day ago', ms: 86_400_000 },
  { key: '3d', label: 'Last tried 3+ days ago', ms: 3 * 86_400_000 },
  { key: '7d', label: 'Last tried 1+ week ago', ms: 7 * 86_400_000 },
];

const CALLABLE = new Set(['new', 'retry', 'callback']);

interface Batch { id: string; name: string; imported_at: string }

export function LeadsPage() {
  const { meta, toast, go } = useApp();
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [batch, setBatch] = useState('');
  const [tried, setTried] = useState('');
  const [notOnList, setNotOnList] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [groups, setGroups, groupParams] = useGroups();
  const outcomeLabel = (c: string | null) => (c ? meta?.outcome_codes.find((o) => o.code === c)?.label ?? c : '');

  useEffect(() => {
    api.get<Batch[]>('/imports').then(setBatches).catch(() => setBatches([]));
  }, []);

  const filters = useMemo(() => {
    const t = TRIED.find((x) => x.key === tried);
    return {
      status,
      search,
      batch_id: batch || undefined,
      tried_before: t?.ms ? new Date(Date.now() - t.ms).toISOString() : undefined,
      not_on_list: notOnList ? '1' : undefined,
      ...groupParams,
    };
  }, [status, search, batch, tried, notOnList, groupParams.counties, groupParams.area_codes]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(
    () => api.get<{ rows: any[]; total: number }>('/leads', filters).then((r) => { setRows(r.rows); setTotal(r.total); }),
    [filters],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);
  // A new filter starts a new choice.
  useEffect(() => setPicked(new Set()), [filters]);

  const pickable = rows.filter((r) => CALLABLE.has(r.status) && !r.on_list);
  const allPicked = pickable.length > 0 && pickable.every((r) => picked.has(r.id));
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const report = (r: AddResult) => {
    const extra = [
      r.already ? `${r.already} already on it` : '',
      r.not_callable ? `${r.not_callable} booked, bad or dead (not added)` : '',
    ].filter(Boolean).join(', ');
    toast(`${r.added} lead${r.added === 1 ? '' : 's'} added to the call list${extra ? `; ${extra}` : ''}`);
  };

  const addPicked = async () => {
    // In the order shown on screen.
    const ids = rows.filter((r) => picked.has(r.id)).map((r) => r.id);
    try {
      report(await api.post<AddResult>('/call-list', { lead_ids: ids }));
      setPicked(new Set());
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const addAll = async () => {
    if (total > 50 && !window.confirm(`Add all ${total} matching leads to the call list?`)) return;
    try {
      report(await api.post<AddResult>('/call-list/add-matching', filters));
      setPicked(new Set());
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <div className="leads-tools">
        <div className="tabs">
          {STATUSES.map((s) => <button key={s.key} className={status === s.key ? 'active' : ''} onClick={() => setStatus(s.key)}>{s.label}</button>)}
        </div>
      </div>
      <div className="leads-tools">
        <input placeholder="Search name, county, phone, or area code" value={search} onChange={(e) => setSearch(e.target.value)} title="A 3-digit number finds every county under that area code" />
        <GroupPicker groups={groups} onChange={setGroups} />
        <select value={batch} onChange={(e) => setBatch(e.target.value)} aria-label="Batch">
          <option value="">All batches</option>
          {batches.map((b) => <option key={b.id} value={b.id}>{b.name} · {fmtDateTime(b.imported_at)}</option>)}
        </select>
        <select value={tried} onChange={(e) => setTried(e.target.value)} aria-label="Last tried">
          {TRIED.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={notOnList} onChange={(e) => setNotOnList(e.target.checked)} /> Not on the call list
        </label>
      </div>
      <div className="leads-tools">
        <span className="muted">{total} lead{total === 1 ? '' : 's'}{rows.length < total ? ` (showing the first ${rows.length})` : ''}</span>
        <div className="add-bar">
          <button className="btn primary" disabled={!picked.size} onClick={() => void addPicked()}>
            Add {picked.size || ''} ticked to call list
          </button>
          <button className="btn" disabled={!total} onClick={() => void addAll()} title="Every lead matching these filters, not just the ones shown. Booked, bad-number and dead leads are left out.">
            Add all {total} matching
          </button>
          <button className="btn" onClick={() => go('calling')}>Go to Calling</button>
        </div>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th className="pick">
              <input
                type="checkbox"
                aria-label="Tick every lead shown"
                checked={allPicked}
                disabled={!pickable.length}
                onChange={() => setPicked(allPicked ? new Set() : new Set(pickable.map((r) => r.id)))}
              />
            </th>
            <th>Name</th><th>Phone</th><th>County</th><th>Location</th><th>Batch</th><th>Status</th><th>Attempts</th><th>Last call</th><th>Last outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const can = CALLABLE.has(r.status) && !r.on_list;
            return (
              <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
                <td className="pick" onClick={(e) => e.stopPropagation()}>
                  {r.on_list ? (
                    <span className="muted" title="Already on the call list">✓</span>
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={`Tick ${fullName(r)}`}
                      checked={picked.has(r.id)}
                      disabled={!can}
                      title={can ? 'Tick to add to the call list' : 'Booked, bad-number and dead leads can\'t be called. Restore it first.'}
                      onChange={() => toggle(r.id)}
                    />
                  )}
                </td>
                <td>{fullName(r)}</td>
                <td>{fmtPhone(r.phone_e164)}</td><td>{r.county ?? ''}</td><td>{[r.city, r.state].filter(Boolean).join(', ')}</td>
                <td>{r.batch_name}</td><td><StatusBadge status={r.status} />{r.on_list && <span className="badge" style={{ marginLeft: 4 }}>on call list</span>}</td>
                <td>{r.attempts_total}</td><td>{fmtDateTime(r.last_call_at)}</td><td>{outcomeLabel(r.last_outcome_code)}</td>
              </tr>
            );
          })}
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
