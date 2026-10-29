import { useEffect, useRef, useState } from 'react';
import { api, fmtDateTime, fmtPhone } from '../api';
import { useApp } from '../App';
import { getStoredJson, setStoredJson } from '../storage';
import { fromWall, todayRange, ymd } from '../when';
import type { PrepCard } from '../../shared/appointments';

// Tells you when a callback comes due or an appointment is about to start: a desktop notification, a short sound,
// and a bar in the app. Appointments have their own "minutes before" in Settings.
// Checks once a minute while the app is open.

export interface AgendaItem {
  lead_id: string;
  name: string;
  phone_e164: string | null;
  time_zone: string | null;
  county: string | null;
  state: string | null;
  due_at?: string | null;
  /** A callback for a day, any time that day (due_at is the start of the day). */
  any_time?: number | boolean;
}
export interface Agenda {
  callbacks: AgendaItem[];
  /** The appointments of the `day` asked for (none when no day is sent). */
  appointments: PrepCard[];
}

const SEEN_KEY = 'mpcrm.alerts.seen';

function loadSeen(): Set<string> {
  const ids = getStoredJson<string[]>(SEEN_KEY);
  return new Set(Array.isArray(ids) ? ids : []);
}
function saveSeen(s: Set<string>) {
  setStoredJson(SEEN_KEY, [...s].slice(-500));
}

/** Two short tones. Made in the browser, so no sound file is needed. */
export function chime() {
  try {
    const ctx = new AudioContext();
    [0, 0.18].forEach((t, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i ? 880 : 660;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.17);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* no audio */
  }
}

/** Something to alert for: a callback coming due, or an appointment about to start. */
interface Due {
  key: string;
  kind: 'callback' | 'appointment';
  item: AgendaItem | PrepCard;
  at: string;
}
const TITLE: Record<Due['kind'], string> = { callback: 'Callback due', appointment: 'Appointment' };

export function CallbackAlerts() {
  const { calling, openLead } = useApp();
  const [due, setDue] = useState<Due[]>([]);
  const seen = useRef(loadSeen());
  const alerts = calling?.settings.alerts;

  useEffect(() => {
    if (!alerts) return;
    const check = async () => {
      let a: Agenda;
      try {
        a = await api.get<Agenda>('/agenda', { ...todayRange(), day: ymd(new Date()) });
      } catch {
        return;
      }
      const now = Date.now();
      const fresh: Due[] = [];
      const consider = (kind: Due['kind'], item: Due['item'], at: string | null | undefined, minutesBefore: number) => {
        if (!at) return;
        const t = Date.parse(at);
        // Only alert for things coming due now, not for ones missed hours ago (those are at the top of the queue).
        if (t - minutesBefore * 60_000 > now || now - t > 30 * 60_000) return;
        const key = `${kind}:${item.lead_id}:${at}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        fresh.push({ key, kind, item, at });
      };
      // "Any time" callbacks and appointments with no time have no moment to alert for; they wait on Today.
      for (const c of a.callbacks) if (!c.any_time) consider('callback', c, c.due_at, alerts.minutes_before);
      if (alerts.appt_minutes_before != null) {
        for (const p of a.appointments) {
          const w = fromWall(p.scheduled_for);
          if (!w.anyTime) consider('appointment', p, w.at.toISOString(), alerts.appt_minutes_before);
        }
      }
      if (!fresh.length) return;
      saveSeen(seen.current);
      setDue((d) => [...d, ...fresh]);
      if (alerts.sound) chime();
      if (alerts.desktop && 'Notification' in window && Notification.permission === 'granted') {
        for (const f of fresh) {
          const n = new Notification(`${TITLE[f.kind]}: ${f.item.name}`, {
            body: `${fmtDateTime(f.at)} · ${fmtPhone(f.item.phone_e164)}${'county' in f.item && f.item.county ? ` · ${f.item.county} Co.` : ''}`,
            tag: f.key,
          });
          n.onclick = () => {
            window.focus();
            openLead(f.item.lead_id);
            n.close();
          };
        }
      }
    };
    void check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [alerts?.desktop, alerts?.sound, alerts?.minutes_before, alerts?.appt_minutes_before, openLead]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!due.length) return null;
  return (
    <div className="alert-bar" role="alert">
      {due.map((d) => (
        <div key={d.key} className="row">
          <b>{TITLE[d.kind]}:</b>
          <span>{d.item.name} · {fmtDateTime(d.at)} · {fmtPhone(d.item.phone_e164)}</span>
          <button className="btn small primary" onClick={() => { openLead(d.item.lead_id); setDue((x) => x.filter((y) => y.key !== d.key)); }}>Open</button>
          <button className="btn small" onClick={() => setDue((x) => x.filter((y) => y.key !== d.key))} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
