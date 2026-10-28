import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtDuration, fmtPhone, type CallerNumber } from '../api';
import { useApp } from '../App';
import { LeadViewer } from '../components/LeadViewer';
import { GroupPicker, useGroups } from '../components/GroupPicker';
import { dayRange, ymd } from '../when';

export function CallsPage() {
  const { meta, toast, bumpStats } = useApp();
  const [day, setDay] = useState(() => ymd(new Date()));
  const [outcome, setOutcome] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [groups, setGroups, groupParams] = useGroups();
  const [fromNumber, setFromNumber] = useState('');
  const [version, setVersion] = useState(0);
  // Ticked calls, for changing their caller ID together. `last` is the row a shift-click ticks from.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [last, setLast] = useState<number | null>(null);
  const [newNumber, setNewNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const label = (c: string | null) => meta?.outcome_codes.find((o) => o.code === c)?.label ?? c ?? 'no outcome';

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .get<any[]>('/calls', {
          ...dayRange(new Date(`${day}T00:00:00`)), outcome: outcome || undefined, search, from_number: fromNumber || undefined, ...groupParams,
        })
        .then(setRows)
        .catch((e: Error) => toast(`Couldn't load calls: ${e.message}`, 'error'));
    }, search ? 200 : 0);
    return () => clearTimeout(t);
  }, [day, outcome, open, search, fromNumber, version, groupParams.counties, groupParams.area_codes]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new filter shows other calls: start the ticking over.
  useEffect(() => {
    setPicked(new Set());
    setLast(null);
  }, [day, outcome, search, fromNumber, groupParams.counties, groupParams.area_codes]);

  const pickable = rows.filter((r) => !r.voided_at);
  const ticked = pickable.filter((r) => picked.has(r.id));
  const allPicked = pickable.length > 0 && ticked.length === pickable.length;
  const tick = (i: number, shift: boolean) => {
    const next = new Set(picked);
    const on = !picked.has(rows[i].id);
    const [a, b] = shift && last !== null ? [Math.min(last, i), Math.max(last, i)] : [i, i];
    for (let j = a; j <= b; j++) {
      if (rows[j].voided_at) continue;
      if (on) next.add(rows[j].id);
      else next.delete(rows[j].id);
    }
    setPicked(next);
    setLast(i);
  };
  const numberName = (n: CallerNumber) => `${n.label ? `${n.label} ` : ''}${fmtPhone(n.e164)}${n.status === 'retired' ? ' (retired)' : ''}`;

  const changeCallerId = async () => {
    const target = newNumber === 'none' ? null : newNumber;
    const name = target ? numberName(meta!.numbers.find((n) => n.id === target)!) : 'no caller ID';
    if (!window.confirm(`Change the caller ID on ${ticked.length} call${ticked.length === 1 ? '' : 's'} to ${name}?`)) return;
    setSaving(true);
    try {
      const r = await api.post<{ changed: number; skipped: { undone: number; same: number; missing: number } }>('/calls/caller-id', {
        call_ids: ticked.map((c) => c.id), from_number_id: target,
      });
      const extra = r.skipped.same ? ` (${r.skipped.same} already had it)` : '';
      toast(`Caller ID changed to ${name} on ${r.changed} call${r.changed === 1 ? '' : 's'}${extra}`);
      setPicked(new Set());
      setLast(null);
      setVersion((v) => v + 1);
      bumpStats();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Time on lead, for calls saved from the Calling page that weren't undone.
  const timed = rows.filter((r) => r.lead_seconds != null && !r.voided_at);
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
        <label className="field"><span>Search</span><input placeholder="Name, county, phone, or area code" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label className="field"><span>Caller ID</span>
          <select value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} aria-label="Only calls from">
            <option value="">All</option>
            {meta?.numbers.map((n) => <option key={n.id} value={n.id}>{numberName(n)}</option>)}
            <option value="none">No caller ID</option>
          </select>
        </label>
        <GroupPicker groups={groups} onChange={setGroups} />
        <span className="muted">{rows.length} call(s){timed.length > 0 && <> · average {fmtDuration(timed.reduce((t, r) => t + r.lead_seconds, 0) / timed.length)} per lead</>}</span>
        <a className="btn small" href="/api/export/calls.csv" style={{ marginLeft: 'auto' }}>Export all calls (CSV)</a>
      </div>
      {!outcome && rows.length > 0 && (
        <div className="summary-tiles">
          {Object.entries(counts).map(([k, n]) => <div key={k}><b>{n}</b>{label(k === 'none' ? null : k)}</div>)}
        </div>
      )}
      <div className="leads-tools">
        <span className="muted">Tick calls to fix their caller ID. Shift-click ticks a run of calls.</span>
        <div className="add-bar">
          <label className="field"><span>Change caller ID to</span>
            <select value={newNumber} onChange={(e) => setNewNumber(e.target.value)} aria-label="New caller ID">
              <option value="">Pick a number…</option>
              {meta?.numbers.map((n) => <option key={n.id} value={n.id}>{numberName(n)}</option>)}
              <option value="none">No caller ID</option>
            </select>
          </label>
          <button className="btn primary" disabled={!ticked.length || !newNumber || saving} onClick={() => void changeCallerId()}>
            Change {ticked.length || ''} ticked
          </button>
          {ticked.length > 0 && <button className="btn" onClick={() => setPicked(new Set())}>Clear</button>}
        </div>
      </div>
      <table className="grid">
        <thead><tr>
          <th className="pick">
            <input
              type="checkbox"
              aria-label="Tick every call shown"
              checked={allPicked}
              disabled={!pickable.length}
              onChange={() => setPicked(allPicked ? new Set() : new Set(pickable.map((r) => r.id)))}
            />
          </th>
          <th>Time</th><th>Lead</th><th>County</th><th>To</th><th>Caller ID</th><th>Outcome</th><th>Talk</th><th>On lead</th><th>Source</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="click" onClick={() => r.lead_id && setOpen(r.lead_id)}>
              <td className="pick" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Tick the call to ${r.lead_name}`}
                  checked={picked.has(r.id)}
                  disabled={!!r.voided_at}
                  title={r.voided_at ? 'This call was undone' : undefined}
                  onChange={(e) => tick(i, (e.nativeEvent as MouseEvent).shiftKey)}
                />
              </td>
              <td>{fmtDateTime(r.requested_at)}</td><td>{r.lead_name}</td><td>{r.county ?? ''}</td><td>{fmtPhone(r.to_e164)}</td>
              <td>{r.from_label ?? ''} {fmtPhone(r.from_e164)}</td><td>{label(r.outcome_code)}</td>
              <td>{r.talk_seconds != null ? `${Math.round(r.talk_seconds / 60)} min` : ''}</td>
              <td>{fmtDuration(r.lead_seconds)}</td>
              <td className="muted">{r.channel === 'manual_log' ? 'logged by hand' : r.channel}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty">No calls on this day match.</div>}
      {open && (
        <LeadViewer
          id={open}
          list={rows.filter((r) => r.lead_id).map((r) => ({ id: r.lead_id, name: r.lead_name, phone: r.to_e164, county: r.county }))}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
