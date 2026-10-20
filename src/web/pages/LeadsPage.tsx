import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime, fmtPhone, fullName, type AddResult, type CallListResponse } from '../api';
import { ClearListDialog, suggestListName } from '../components/CallListDialogs';
import { useApp } from '../App';
import { StatusBadge } from '../components/LeadView';
import { LeadViewer } from '../components/LeadViewer';
import { GroupPicker, useGroups } from '../components/GroupPicker';

// Where you pick who to call: filter the leads, tick the ones you want (or take every match),
// and add them to the bottom of the call list on the Calling page, or put them in place of it.

// One tab per way a lead can stand, matching the outcome keys on the Calling screen.
const STATUSES = [
  { key: 'all', label: 'All' }, { key: 'new', label: 'Never called' },
  { key: 'no_answer', label: 'No answer', title: 'Called, but the last call didn\'t reach them' },
  { key: 'talked', label: 'Talked, no appt' }, { key: 'callback', label: 'Callbacks' },
  { key: 'appointment_set', label: 'Appointment set' }, { key: 'invalid', label: 'Bad numbers' }, { key: 'dead', label: 'Dead pile' },
];

/** Midnight at the start of today, your time, `days` days back. */
function dayStart(days = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/** When the last call was: a recent window, or long enough ago to try again. */
const LAST_CALL: { key: string; label: string; range: () => { after?: string; before?: string } }[] = [
  { key: '', label: 'Last call: any time', range: () => ({}) },
  { key: 'today', label: 'Last call today', range: () => ({ after: dayStart() }) },
  { key: 'yesterday', label: 'Last call yesterday', range: () => ({ after: dayStart(1), before: dayStart() }) },
  { key: 'week', label: 'Last call in the past 7 days', range: () => ({ after: dayStart(6) }) },
  { key: '4h', label: 'Last call 4+ hours ago', range: () => ({ before: ago(4 * 3600_000) }) },
  { key: '1d', label: 'Last call 1+ day ago', range: () => ({ before: ago(86_400_000) }) },
  { key: '3d', label: 'Last call 3+ days ago', range: () => ({ before: ago(3 * 86_400_000) }) },
  { key: '7d', label: 'Last call 1+ week ago', range: () => ({ before: ago(7 * 86_400_000) }) },
];
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const CALLABLE = new Set(['new', 'retry', 'callback']);

interface Batch { id: string; name: string; imported_at: string }
interface BulkRun { id: string; created_at: string; totals: { files: number; leads: number } }

const SHOW_KEY = 'mpcrm.leads.show';

/**
 * Opens the Leads page showing one import: a batch (one file) or a bulk import (all its files).
 * Call it, then go('leads').
 */
export function showImportedLeads(what: { batch: string } | { bulk: string }) {
  try {
    localStorage.setItem(SHOW_KEY, 'batch' in what ? what.batch : `bulk:${what.bulk}`);
  } catch {
    /* storage unavailable */
  }
}

/** The import the Leads page was asked to show, used once. */
function takeShown(): string {
  try {
    const v = localStorage.getItem(SHOW_KEY) ?? '';
    localStorage.removeItem(SHOW_KEY);
    return v;
  } catch {
    return '';
  }
}

export function LeadsPage() {
  const { meta, toast, go } = useApp();
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  /** A batch id, or "bulk:<id>" for every file of a bulk import. */
  const [batch, setBatch] = useState(takeShown);
  const [tried, setTried] = useState('');
  const [notOnList, setNotOnList] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [bulks, setBulks] = useState<BulkRun[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [groups, setGroups, groupParams] = useGroups();
  const [callList, setCallList] = useState<CallListResponse | null>(null);
  const [replace, setReplace] = useState(false);
  /** Waiting on "keep the old list?" before replacing it with these leads. */
  const [replacing, setReplacing] = useState<'picked' | 'all' | null>(null);
  const loadCallList = useCallback(() => api.get<CallListResponse>('/call-list').then(setCallList).catch(() => setCallList(null)), []);
  useEffect(() => void loadCallList(), [loadCallList]);
  const onList = callList?.items.length ?? 0;
  const replaceNow = replace && onList > 0;
  const outcomeLabel = (c: string | null) => (c ? meta?.outcome_codes.find((o) => o.code === c)?.label ?? c : '');

  useEffect(() => {
    api.get<Batch[]>('/imports').then(setBatches).catch(() => setBatches([]));
    api.get<BulkRun[]>('/bulk-imports').then(setBulks).catch(() => setBulks([]));
  }, []);

  const filters = useMemo(() => {
    const r = (LAST_CALL.find((x) => x.key === tried) ?? LAST_CALL[0]!).range();
    return {
      status,
      search,
      batch_id: batch && !batch.startsWith('bulk:') ? batch : undefined,
      bulk_id: batch.startsWith('bulk:') ? batch.slice(5) : undefined,
      tried_before: r.before,
      tried_after: r.after,
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

  const pickable = rows.filter((r) => CALLABLE.has(r.status) && (!r.on_list || replaceNow));
  const allPicked = pickable.length > 0 && pickable.every((r) => picked.has(r.id));
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const filtered = status !== 'all' || !!search || !!batch || !!tried || notOnList;
  const clearFilters = () => {
    setStatus('all');
    setSearch('');
    setBatch('');
    setTried('');
    setNotOnList(false);
  };

  const report = (r: AddResult, replaced = false) => {
    if (replaced) {
      toast(`Call list replaced: ${r.added} lead${r.added === 1 ? '' : 's'} on it${r.not_callable ? `; ${r.not_callable} booked, bad or dead (not added)` : ''}`);
      return;
    }
    const extra = [
      r.already ? `${r.already} already on it` : '',
      r.not_callable ? `${r.not_callable} booked, bad or dead (not added)` : '',
    ].filter(Boolean).join(', ');
    toast(`${r.added} lead${r.added === 1 ? '' : 's'} added to the call list${extra ? `; ${extra}` : ''}`);
  };

  const addPicked = async (swap?: { save_current_as: string | null }) => {
    // In the order shown on screen.
    const ids = rows.filter((r) => picked.has(r.id)).map((r) => r.id);
    try {
      report(await api.post<AddResult>('/call-list', { lead_ids: ids, ...(swap ? { replace: true, ...swap } : {}) }), !!swap);
      setPicked(new Set());
      setReplacing(null);
      await Promise.all([load(), loadCallList()]);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const addAll = async (swap?: { save_current_as: string | null }) => {
    if (!swap && total > 50 && !window.confirm(`Add all ${total} matching leads to the call list?`)) return;
    try {
      report(await api.post<AddResult>('/call-list/add-matching', { ...filters, ...(swap ? { replace: true, ...swap } : {}) }), !!swap);
      setPicked(new Set());
      setReplacing(null);
      await Promise.all([load(), loadCallList()]);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <div className="leads-tools">
        <div className="tabs">
          {STATUSES.map((s) => (
            <button key={s.key} className={status === s.key ? 'active' : ''} title={s.title} onClick={() => setStatus(s.key)}>{s.label}</button>
          ))}
        </div>
      </div>
      <div className="leads-tools">
        <input placeholder="Search name, county, phone, or area code" value={search} onChange={(e) => setSearch(e.target.value)} title="A 3-digit number finds every county under that area code" />
        <GroupPicker groups={groups} onChange={setGroups} />
        <select value={batch} onChange={(e) => setBatch(e.target.value)} aria-label="Batch">
          <option value="">All batches</option>
          {bulks.length > 0 && (
            <optgroup label="Bulk imports (every file)">
              {bulks.map((b) => (
                <option key={b.id} value={`bulk:${b.id}`}>Bulk import · {fmtDateTime(b.created_at)} · {b.totals.files} files</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Batches">
            {batches.map((b) => <option key={b.id} value={b.id}>{b.name} · {fmtDateTime(b.imported_at)}</option>)}
          </optgroup>
        </select>
        <select value={tried} onChange={(e) => setTried(e.target.value)} aria-label="Last call">
          {LAST_CALL.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <label className="row" style={{ gap: 4 }} title="Leaves out leads still waiting to be called on the list. Ones you already called from it can go back on.">
          <input type="checkbox" checked={notOnList} onChange={(e) => setNotOnList(e.target.checked)} /> Not on the call list
        </label>
        {filtered && <button className="btn small" onClick={clearFilters}>Clear filters</button>}
      </div>
      <div className="leads-tools">
        <span className="muted">{total} lead{total === 1 ? '' : 's'}{rows.length < total ? ` (showing the first ${rows.length})` : ''}</span>
        <div className="add-bar">
          {onList > 0 && (
            <label className="row" style={{ gap: 4 }} title="Empty the call list first, so only these leads are on it. You can keep the old list to call later.">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the call list ({onList} on it now)
            </label>
          )}
          <button className="btn primary" disabled={!picked.size} onClick={() => (replaceNow ? setReplacing('picked') : void addPicked())}>
            {replaceNow ? `Replace with ${picked.size || ''} ticked` : `Add ${picked.size || ''} ticked to call list`}
          </button>
          <button
            className="btn"
            disabled={!total}
            onClick={() => (replaceNow ? setReplacing('all') : void addAll())}
            title="Every lead matching these filters, not just the ones shown. Booked, bad-number and dead leads are left out."
          >
            {replaceNow ? `Replace with all ${total} matching` : `Add all ${total} matching`}
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
            const can = CALLABLE.has(r.status) && (!r.on_list || replaceNow);
            return (
              <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
                <td className="pick" onClick={(e) => e.stopPropagation()}>
                  {r.on_list && !replaceNow ? (
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
      {replacing && callList && (
        <ClearListDialog
          title={`Replace your call list with ${replacing === 'all' ? `all ${total} matching` : `${picked.size} ticked`} lead${(replacing === 'all' ? total : picked.size) === 1 ? '' : 's'}?`}
          confirmLabel="Replace call list"
          count={onList}
          defaultName={suggestListName(callList.items, callList.name)}
          onConfirm={(name) => (replacing === 'all' ? addAll({ save_current_as: name }) : addPicked({ save_current_as: name }))}
          onCancel={() => setReplacing(null)}
        />
      )}
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
