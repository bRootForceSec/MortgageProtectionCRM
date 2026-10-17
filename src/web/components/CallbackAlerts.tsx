import { useEffect, useRef, useState } from 'react';
import { api, fmtDateTime, fmtPhone } from '../api';
import { useApp } from '../App';

// Tells you when a callback comes due: a desktop notification, a short sound, and a bar in the app.
// Checks once a minute while the app is open.

export interface AgendaItem {
  lead_id: string;
  name: string;
  phone_e164: string | null;
  time_zone: string | null;
  county: string | null;
  state: string | null;
  due_at?: string | null;
}
export interface Agenda {
  callbacks: AgendaItem[];
}

const SEEN_KEY = 'mpcrm.alerts.seen';

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
function saveSeen(s: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500)));
  } catch {
    /* storage unavailable */
  }
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

export function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
}

export function CallbackAlerts() {
  const { calling, openLead } = useApp();
  const [due, setDue] = useState<{ key: string; kind: 'callback'; item: AgendaItem; at: string }[]>([]);
  const seen = useRef(loadSeen());
  const alerts = calling?.settings.alerts;

  useEffect(() => {
    if (!alerts) return;
    const check = async () => {
      let a: Agenda;
      try {
        a = await api.get<Agenda>('/agenda', todayRange());
      } catch {
        return;
      }
      const now = Date.now();
      const ahead = alerts.minutes_before * 60_000;
      const fresh: typeof due = [];
      const consider = (kind: 'callback', item: AgendaItem, at: string | null | undefined) => {
        if (!at) return;
        const t = Date.parse(at);
        // Only alert for things coming due now, not for ones missed hours ago (those are at the top of the queue).
        if (t - ahead > now || now - t > 30 * 60_000) return;
        const key = `${kind}:${item.lead_id}:${at}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        fresh.push({ key, kind, item, at });
      };
      for (const c of a.callbacks) consider('callback', c, c.due_at);
      if (!fresh.length) return;
      saveSeen(seen.current);
      setDue((d) => [...d, ...fresh]);
      if (alerts.sound) chime();
      if (alerts.desktop && 'Notification' in window && Notification.permission === 'granted') {
        for (const f of fresh) {
          const n = new Notification(`Callback due: ${f.item.name}`, {
            body: `${fmtDateTime(f.at)} · ${fmtPhone(f.item.phone_e164)}${f.item.county ? ` · ${f.item.county} Co.` : ''}`,
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
  }, [alerts?.desktop, alerts?.sound, alerts?.minutes_before, openLead]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!due.length) return null;
  return (
    <div className="alert-bar" role="alert">
      {due.map((d) => (
        <div key={d.key} className="row">
          <b>Callback due:</b>
          <span>{d.item.name} · {fmtDateTime(d.at)} · {fmtPhone(d.item.phone_e164)}</span>
          <button className="btn small primary" onClick={() => { openLead(d.item.lead_id); setDue((x) => x.filter((y) => y.key !== d.key)); }}>Open</button>
          <button className="btn small" onClick={() => setDue((x) => x.filter((y) => y.key !== d.key))} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
