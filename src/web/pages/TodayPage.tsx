import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtPhone } from '../api';
import { useApp } from '../App';
import { todayRange, type Agenda, type AgendaItem } from '../components/CallbackAlerts';
import { GroupPicker, useGroups } from '../components/GroupPicker';

// Callbacks: the ones you missed, today's, and the next two weeks, in your time and the lead's time.
// They're kept apart from the call list: Open shows the lead on the Calling page without changing your list.
// Appointments are followed up in Unitrust.

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
    const load = () => api.get<Agenda>('/agenda', { from: todayRange().from, to: new Date(Date.parse(todayRange().to) + 14 * 86_400_000).toISOString(), ...groupParams }).then(setA).catch((e) => toast(e.message, 'error'));
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [toast, groupParams.counties, groupParams.area_codes]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return null;
  const now = new Date().toISOString();
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const anyTimeToday = (c: AgendaItem) => !!c.any_time && !!c.due_at && c.due_at >= startOfToday && c.due_at < todayRange().to;
  const anyTime = a.callbacks.filter(anyTimeToday);
  const overdue = a.callbacks.filter((c) => c.due_at && c.due_at < now && !anyTimeToday(c));
  const endOfToday = todayRange().to;
  const later = a.callbacks.filter((c) => c.due_at && c.due_at >= now && c.due_at < endOfToday && !anyTimeToday(c));
  const comingUp = a.callbacks.filter((c) => c.due_at && c.due_at >= endOfToday);
  const noTime = a.callbacks.filter((c) => !c.due_at);

  const Row = ({ i, at }: { i: AgendaItem; at: string | null | undefined }) => (
    <tr>
      <td className="nowrap">
        {!at ? <span className="warn">no time yet</span>
          : i.any_time ? (anyTimeToday(i) ? 'Any time today' : `${new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, any time`)
            : fmtDateTime(at)}
      </td>
      <td className="nowrap muted">{!i.any_time && theirTime(at, i.time_zone) && `${theirTime(at, i.time_zone)} theirs`}</td>
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
        <h2>Callbacks</h2>
        <GroupPicker groups={groups} onChange={setGroups} />
      </div>
      {empty && <p className="muted">No callbacks set.</p>}
      <Section title="Callbacks you missed" items={overdue} />
      <Section title="Callbacks any time today" items={anyTime} />
      <Section title="Callbacks later today" items={later} />
      <Section title="Callbacks that need a time" items={noTime} />
      <Section title="Coming up (next two weeks)" items={comingUp} />
      <p className="help">Callbacks stay off your call list; Open shows the lead on the Calling page beside your list. You get a desktop alert and a sound when a callback with a time comes due, while the app is open. Change that in Settings. Appointments are followed up in Unitrust.</p>
    </div>
  );
}
