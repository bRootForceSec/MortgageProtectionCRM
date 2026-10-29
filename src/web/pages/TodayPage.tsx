import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtMoney, fmtPhone, personAge } from '../api';
import { useApp } from '../App';
import { type Agenda, type AgendaItem } from '../components/CallbackAlerts';
import { fromWall, todayRange, ymd } from '../when';
import { GroupPicker, useGroups } from '../components/GroupPicker';
import { ApptBadge } from '../components/LeadDetails';
import { useLeadTypes } from '../leadTypes';
import type { PrepCard } from '../../shared/appointments';

// Today: the day's appointments, each with a prep card, then callbacks (the ones you missed, today's, and the next
// two weeks, in your time and the lead's time). Both are kept apart from the call list: Open shows the lead on the
// Calling page without changing your list. Appointment results are still set in Unitrust or on the Appointment side.

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
    const load = () => api.get<Agenda>('/agenda', { from: todayRange().from, to: new Date(Date.parse(todayRange().to) + 14 * 86_400_000).toISOString(), day: ymd(new Date()), ...groupParams }).then(setA).catch((e) => toast(e.message, 'error'));
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [toast, groupParams.counties, groupParams.area_codes]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return null;
  const now = new Date().toISOString();
  const startOfToday = todayRange().from;
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
        <h2>Today</h2>
        <GroupPicker groups={groups} onChange={setGroups} />
      </div>
      <h3>Appointments today <span className="muted">({a.appointments.length})</span></h3>
      {a.appointments.length ? (
        <div className="prep-cards">
          {a.appointments.map((p) => <Prep key={p.appointment_id} p={p} onOpen={() => openLead(p.lead_id)} />)}
        </div>
      ) : <p className="muted">No appointments today.</p>}
      <h3>Callbacks</h3>
      {empty && <p className="muted">No callbacks set.</p>}
      <Section title="Callbacks you missed" items={overdue} />
      <Section title="Callbacks any time today" items={anyTime} />
      <Section title="Callbacks later today" items={later} />
      <Section title="Callbacks that need a time" items={noTime} />
      <Section title="Coming up (next two weeks)" items={comingUp} />
      <p className="help">Appointments come from the time you type on Appt set and from the Unitrust calendar; once Unitrust has the appointment, its time wins. The group picker narrows callbacks only. Callbacks stay off your call list; Open shows the lead on the Calling page beside your list. You get a desktop alert and a sound when a callback with a time comes due, and shortly before an appointment with a time, while the app is open. Change that in Settings.</p>
    </div>
  );
}

/** What you want in front of you before an appointment: the loan, who's on it, age, health answers and your last note. */
function Prep({ p, onOpen }: { p: PrepCard; onOpen: () => void }) {
  const { types } = useLeadTypes();
  const when = fromWall(p.scheduled_for);
  const myZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const age = personAge({ dob: p.dob, age: p.age });
  const health = ([
    ['Tobacco', p.tobacco_raw], ['Heart attack', p.health_heart_raw], ['Stroke', p.health_stroke_raw], ['Cancer', p.health_cancer_raw], ['Diabetes', p.health_diabetes_raw],
  ] as const).filter(([, v]) => v);
  const facts = ([
    ['Lender', p.lender],
    ['Loan', fmtMoney(p.loan_amount_cents)],
    ['Age', age != null ? String(age) : null],
    ['On the loan', p.coborrower_raw],
    ['Lead type', types.find((t) => t.code === p.lead_type)?.label ?? p.lead_type],
  ] as const).filter(([, v]) => v);
  return (
    <div className="prep-card" aria-label={`Appointment with ${p.name || 'no name'}`}>
      <div className="prep-head">
        <b className="nowrap">{when.anyTime ? 'No time yet' : when.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</b>
        {!when.anyTime && p.time_zone !== myZone && theirTime(when.at.toISOString(), p.time_zone) && <span className="muted nowrap">{theirTime(when.at.toISOString(), p.time_zone)} theirs</span>}
        <span className="prep-name">{p.name || '(no name)'}</span>
        <ApptBadge result={p.appt_result} />
        <button className="btn small primary" onClick={onOpen}>Open</button>
      </div>
      <div className="muted">
        {fmtPhone(p.phone_e164)}{[p.city, p.state].filter(Boolean).length ? ` · ${[p.city, p.state].filter(Boolean).join(', ')}` : ''}
        {p.source === 'app' && ' · not in Unitrust yet'}
      </div>
      {facts.length > 0 && <dl className="prep-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
      {health.length > 0 && <dl className="prep-facts">{health.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
      {p.last_note && <p className="prep-note"><span className="muted">Last note:</span> {p.last_note}</p>}
    </div>
  );
}
