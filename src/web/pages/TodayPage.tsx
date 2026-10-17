import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime, fmtPhone, toLocalInput } from '../api';
import { defaultWhen } from '../when';
import { useApp } from '../App';
import { todayRange, type Agenda, type AgendaItem } from '../components/CallbackAlerts';
import { GroupPicker, useGroups } from '../components/GroupPicker';
import { CalendarBadge, CalendarProblems } from '../components/Calendar';

// Today's callbacks and appointments, in your time and the lead's time.

function theirTime(iso: string | null | undefined, tz: string | null) {
  if (!iso || !tz) return '';
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
  } catch {
    return '';
  }
}

export function TodayPage() {
  const { openLead, toast } = useApp();
  const [a, setA] = useState<Agenda | null>(null);
  const [groups, setGroups, groupParams] = useGroups();
  useEffect(() => {
    const load = () => api.get<Agenda>('/agenda', { ...todayRange(), ...groupParams }).then(setA).catch((e) => toast(e.message, 'error'));
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [toast, groupParams.counties, groupParams.area_codes]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return null;
  const now = new Date().toISOString();
  const overdue = a.callbacks.filter((c) => c.due_at && c.due_at < now);
  const later = a.callbacks.filter((c) => c.due_at && c.due_at >= now);
  const noTime = a.callbacks.filter((c) => !c.due_at);
  const dated = a.appointments.filter((p) => p.scheduled_for);
  const undated = a.appointments.filter((p) => !p.scheduled_for);

  const Row = ({ i, at, extra }: { i: AgendaItem; at: string | null | undefined; extra?: string | null }) => (
    <tr>
      <td className="nowrap">{at ? fmtDateTime(at) : <span className="warn">no time yet</span>}</td>
      <td className="nowrap muted">{theirTime(at, i.time_zone) && `${theirTime(at, i.time_zone)} theirs`}</td>
      <td>{i.name || '(no name)'}</td>
      <td className="nowrap">{fmtPhone(i.phone_e164)}</td>
      <td>{i.county ? `${i.county} Co., ${i.state ?? ''}` : i.state ?? ''}</td>
      <td>{extra}{i.calendar_state && <> <CalendarBadge state={i.calendar_state} /></>}</td>
      <td><button className="btn small primary" onClick={() => openLead(i.lead_id)}>Open</button></td>
    </tr>
  );
  const Section = ({ title, items, kind }: { title: string; items: AgendaItem[]; kind: 'cb' | 'appt' }) =>
    items.length ? (
      <>
        <h3>{title} <span className="muted">({items.length})</span></h3>
        <table className="grid">
          <tbody>
            {items.map((i) => <Row key={`${i.lead_id}-${i.id ?? ''}`} i={i} at={kind === 'cb' ? i.due_at : i.scheduled_for} extra={i.notes} />)}
          </tbody>
        </table>
      </>
    ) : null;

  const empty = !a.callbacks.length && !a.appointments.length;
  return (
    <>
    <CalendarProblems />
    <HowDidItGo groupParams={groupParams} />
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Today</h2>
        <GroupPicker groups={groups} onChange={setGroups} />
      </div>
      {empty && <p className="muted">No callbacks or appointments today.</p>}
      <Section title="Appointments today" items={dated} kind="appt" />
      <Section title="Callbacks you missed" items={overdue} kind="cb" />
      <Section title="Callbacks later today" items={later} kind="cb" />
      <Section title="Callbacks that need a time" items={noTime} kind="cb" />
      <Section title="Appointments that need a date" items={undated} kind="appt" />
      <p className="help">You get a desktop alert and a sound when a callback or appointment comes due, while the app is open. Change that in Settings.</p>
    </div>
    </>
  );
}

const RESULTS = [
  ['sat_no_sale', 'Sat, no sale', '1'],
  ['sold', 'Sold (app written)', '2'],
  ['no_show', 'No-show', '3'],
  ['rescheduled', 'Rescheduled', '4'],
  ['canceled', 'Canceled', '5'],
] as const;

interface DueResult {
  id: string;
  lead_id: string;
  name: string;
  scheduled_for: string | null;
  phone_e164: string | null;
  time_zone: string | null;
  county: string | null;
  state: string | null;
}

/** Appointments whose time has passed: one key per result. Feeds sits and apps on the Reports page. */
function HowDidItGo({ groupParams }: { groupParams: Record<string, string> }) {
  const { openLead, toast, calling } = useApp();
  const [rows, setRows] = useState<DueResult[]>([]);
  const [sel, setSel] = useState(0);
  const [resched, setResched] = useState<{ id: string; when: string } | null>(null);
  const [last, setLast] = useState<{ row: DueResult; label: string } | null>(null);
  const load = useCallback(
    () => api.get<DueResult[]>('/appointments/results-due', groupParams).then(setRows).catch(() => {}),
    [groupParams.counties, groupParams.area_codes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const save = useCallback(
    async (row: DueResult, result: string, when?: string) => {
      if (result === 'rescheduled' && !when) {
        setResched({ id: row.id, when: toLocalInput(defaultWhen(calling?.settings.late_cutoff_hour ?? 21)) });
        return;
      }
      try {
        await api.post(`/appointments/${row.id}/result`, { result, rescheduled_for: when ? new Date(when).toISOString() : null });
        setResched(null);
        setLast({ row, label: RESULTS.find((r) => r[0] === result)?.[1] ?? result });
        await load();
      } catch (e: any) {
        toast(e.message, 'error');
      }
    },
    [calling, load, toast],
  );
  const undo = async () => {
    if (!last) return;
    try {
      await api.post(`/appointments/${last.row.id}/result`, { result: 'cleared' });
      setLast(null);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (resched || !rows.length || (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'))) return;
      if (e.key === 'ArrowDown') { setSel((s) => Math.min(rows.length - 1, s + 1)); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { setSel((s) => Math.max(0, s - 1)); e.preventDefault(); }
      else {
        const r = RESULTS.find((x) => x[2] === e.key);
        const row = rows[Math.min(sel, rows.length - 1)];
        if (r && row) { e.preventDefault(); void save(row, r[0]); }
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [rows, sel, resched, save]);

  if (!rows.length && !last) return null;
  return (
    <div className="card" aria-label="How did it go?">
      <h2>How did it go? <span className="muted">({rows.length})</span></h2>
      {last && (
        <div className="row" role="status">
          <span>Saved for {last.row.name || 'this lead'}: <b>{last.label}</b></span>
          <button className="btn small" onClick={undo}>Undo</button>
        </div>
      )}
      <p className="help">Appointments whose time has passed. Press 1 to 5 for the highlighted one (↑ ↓ to move), or click. These are your own notes for your numbers; the IMO site stays the official record.</p>
      <table className="grid">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={i === Math.min(sel, rows.length - 1) ? 'selected' : ''} onClick={() => setSel(i)}>
              <td className="nowrap">{r.scheduled_for ? fmtDateTime(r.scheduled_for) : <span className="warn">no date</span>}</td>
              <td>{r.name || '(no name)'}</td>
              <td className="nowrap">{fmtPhone(r.phone_e164)}</td>
              <td>{r.county ? `${r.county} Co., ${r.state ?? ''}` : r.state ?? ''}</td>
              <td>
                {resched?.id === r.id ? (
                  <div className="row">
                    <input type="datetime-local" autoFocus value={resched.when} onChange={(e) => setResched({ id: r.id, when: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') void save(r, 'rescheduled', resched.when); if (e.key === 'Escape') setResched(null); }} aria-label="New appointment time" />
                    <button className="btn small primary" onClick={() => save(r, 'rescheduled', resched.when)}>Save new time</button>
                    <button className="btn small" onClick={() => setResched(null)}>Cancel</button>
                  </div>
                ) : (
                  <div className="result-keys">
                    {RESULTS.map(([code, label, key]) => (
                      <button key={code} className="btn small" onClick={() => save(r, code)}>{label} <kbd>{key}</kbd></button>
                    ))}
                  </div>
                )}
              </td>
              <td><button className="btn small" onClick={() => openLead(r.lead_id)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
