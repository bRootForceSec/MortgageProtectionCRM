import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtPhone } from '../api';
import { useApp } from '../App';
import { todayRange, type Agenda, type AgendaItem } from '../components/CallbackAlerts';
import { GroupPicker, useGroups } from '../components/GroupPicker';

// Today's callbacks, in your time and the lead's time. Appointments are followed up in Unitrust.

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

  const Row = ({ i, at }: { i: AgendaItem; at: string | null | undefined }) => (
    <tr>
      <td className="nowrap">{at ? fmtDateTime(at) : <span className="warn">no time yet</span>}</td>
      <td className="nowrap muted">{theirTime(at, i.time_zone) && `${theirTime(at, i.time_zone)} theirs`}</td>
      <td>{i.name || '(no name)'}</td>
      <td className="nowrap">{fmtPhone(i.phone_e164)}</td>
      <td>{i.county ? `${i.county} Co., ${i.state ?? ''}` : i.state ?? ''}</td>
      <td><button className="btn small primary" onClick={() => openLead(i.lead_id)}>Open</button></td>
    </tr>
  );
  const Section = ({ title, items }: { title: string; items: AgendaItem[] }) =>
    items.length ? (
      <>
        <h3>{title} <span className="muted">({items.length})</span></h3>
        <table className="grid">
          <tbody>
            {items.map((i) => <Row key={i.lead_id} i={i} at={i.due_at} />)}
          </tbody>
        </table>
      </>
    ) : null;

  const empty = !a.callbacks.length;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Today</h2>
        <GroupPicker groups={groups} onChange={setGroups} />
      </div>
      {empty && <p className="muted">No callbacks today.</p>}
      <Section title="Callbacks you missed" items={overdue} />
      <Section title="Callbacks later today" items={later} />
      <Section title="Callbacks that need a time" items={noTime} />
      <p className="help">You get a desktop alert and a sound when a callback comes due, while the app is open. Change that in Settings. Appointments are followed up in Unitrust.</p>
    </div>
  );
}
