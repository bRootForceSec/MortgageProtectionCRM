import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtPhone } from '../api';
import { useApp } from '../App';
import { todayRange, type Agenda, type AgendaItem } from '../components/CallbackAlerts';
import { GroupPicker, useGroups } from '../components/GroupPicker';

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
      <td>{extra}</td>
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
  );
}
