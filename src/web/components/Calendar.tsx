import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { useApp } from '../App';

// Google Calendar: the Settings card, the calendar line on each appointment, and the problems list on Today.

export interface CalendarProblem {
  appointment_id: string;
  lead_id: string;
  name: string;
  scheduled_for: string | null;
  kind: 'failed' | 'not_sent' | 'unitrust_missing' | 'unitrust_after_undo' | 'time_differs';
  message: string;
  unitrust_start?: string | null;
}

export interface CalendarStatus {
  configured: boolean;
  connected: boolean;
  client_id: string | null;
  email: string | null;
  connected_at: string | null;
  needs_reconnect: boolean;
  reconnect_reason: string | null;
  last_connect_error: string | null;
  last_error: string | null;
  last_run_at: string | null;
  redirect_uri: string;
  problems: CalendarProblem[];
  counts: Record<string, number>;
}

// One shared copy, so the booking box doesn't ask the server on every lead.
let cached: { at: number; s: CalendarStatus } | null = null;
const listeners = new Set<(s: CalendarStatus) => void>();

export async function loadCalendarStatus(force = false): Promise<CalendarStatus> {
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.s;
  const s = await api.get<CalendarStatus>('/calendar');
  cached = { at: Date.now(), s };
  listeners.forEach((f) => f(s));
  return s;
}

export function useCalendarStatus(pollMs = 0): [CalendarStatus | null, () => Promise<void>] {
  const [s, setS] = useState<CalendarStatus | null>(cached?.s ?? null);
  const reload = useCallback(async () => {
    try {
      await loadCalendarStatus(true);
    } catch {
      /* shown elsewhere */
    }
  }, []);
  useEffect(() => {
    listeners.add(setS);
    void loadCalendarStatus().then(setS).catch(() => {});
    const t = pollMs ? setInterval(() => void reload(), pollMs) : null;
    return () => {
      listeners.delete(setS);
      if (t) clearInterval(t);
    };
  }, [pollMs, reload]);
  return [s, reload];
}

export const CALENDAR_STATE: Record<string, { label: string; cls: string; help: string }> = {
  queued: { label: 'Sending to calendar', cls: 'callback', help: 'The #MP event goes on your calendar as soon as Google can be reached.' },
  waiting: { label: 'Waiting for Unitrust', cls: 'new', help: 'The #MP event is on your calendar. Your note goes on Unitrust\'s event once it appears.' },
  noted: { label: 'Note on Unitrust event', cls: 'appointment_set', help: 'Your note is at the top of Unitrust\'s event.' },
  done: { label: 'On calendar', cls: 'done', help: '' },
  cancel: { label: 'Removing from calendar', cls: 'callback', help: '' },
  canceled: { label: 'Removed from calendar', cls: 'done', help: '' },
  failed: { label: 'Calendar problem', cls: 'dead', help: '' },
};

export function CalendarBadge({ state, error }: { state: string | null | undefined; error?: string | null }) {
  if (!state) return null;
  const s = CALENDAR_STATE[state];
  if (!s) return null;
  return <span className={`badge ${s.cls}`} title={error || s.help}>{s.label}</span>;
}

/** The calendar line under an appointment on the lead screen: state, Unitrust link, and the note you can change. */
export function AppointmentCalendar({ a, onChange }: {
  a: { id: string; calendar_state: string | null; calendar_note: string | null; calendar_title: string | null; unitrust_url: string | null; calendar_error: string | null };
  onChange: () => void;
}) {
  const { toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(a.calendar_note ?? '');
  if (!a.calendar_state) return null;
  const saveNote = async () => {
    try {
      await api.put(`/calendar/appointments/${a.id}/note`, { note: note || null });
      setEditing(false);
      toast('Note saved. It goes on the calendar in a moment.');
      void loadCalendarStatus(true);
      onChange();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const retry = async () => {
    try {
      await api.post(`/calendar/appointments/${a.id}/retry`, {});
      toast('Trying again');
      onChange();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const live = !['cancel', 'canceled'].includes(a.calendar_state);
  return (
    <div className="row" style={{ gap: 8, marginTop: 4 }}>
      <CalendarBadge state={a.calendar_state} error={a.calendar_error} />
      {a.unitrust_url && /^https:\/\//.test(a.unitrust_url) && (
        <a className="btn small" href={a.unitrust_url} target="_blank" rel="noreferrer noopener">Open in Unitrust</a>
      )}
      {a.calendar_state === 'failed' && (
        <>
          <span className="warn">{a.calendar_error}</span>
          <button className="btn small" onClick={retry}>Try again</button>
        </>
      )}
      {live && !editing && (
        <span className="muted">
          {a.calendar_note ? <>Note: {a.calendar_note} </> : 'No calendar note. '}
          <button className="btn small" onClick={() => { setNote(a.calendar_note ?? ''); setEditing(true); }}>{a.calendar_note ? 'Change note' : 'Add note'}</button>
        </span>
      )}
      {editing && (
        <>
          <input value={note} onChange={(e) => setNote(e.target.value)} autoFocus style={{ flex: 1, minWidth: 220 }} aria-label="Calendar note"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void saveNote(); } if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }} />
          <button className="btn small primary" onClick={saveNote}>Save note</button>
          <button className="btn small" onClick={() => setEditing(false)}>Cancel</button>
        </>
      )}
    </div>
  );
}

/** Things on the calendar that need you. Shown at the top of Today. */
export function CalendarProblems() {
  const { openLead, toast } = useApp();
  const [s, reload] = useCalendarStatus(60_000);
  if (!s || (!s.needs_reconnect && !s.problems.length)) return null;
  const useTime = async (p: CalendarProblem) => {
    try {
      await api.post(`/calendar/appointments/${p.appointment_id}/use-unitrust-time`, {});
      toast('Appointment time changed to match Unitrust');
      await reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const retry = async (p: CalendarProblem) => {
    try {
      await api.post(`/calendar/appointments/${p.appointment_id}/retry`, {});
      await reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="card" aria-label="Calendar">
      <h2>Calendar needs a look</h2>
      {s.needs_reconnect && (
        <p className="warn">
          Google stopped accepting the app's sign-in, so appointments aren't reaching your calendar. Go to Settings → Google Calendar and click Connect.
          {s.reconnect_reason ? <span className="muted"> ({s.reconnect_reason})</span> : null}
        </p>
      )}
      {s.problems.length > 0 && (
        <table className="grid">
          <tbody>
            {s.problems.map((p) => (
              <tr key={`${p.appointment_id}-${p.kind}`}>
                <td className="nowrap">{p.scheduled_for ? fmtDateTime(p.scheduled_for) : ''}</td>
                <td>{p.name || '(no name)'}</td>
                <td>
                  {p.message}
                  {p.kind === 'time_differs' && p.unitrust_start && <> Unitrust: <b>{fmtDateTime(p.unitrust_start)}</b>, CRM: <b>{fmtDateTime(p.scheduled_for)}</b>.</>}
                </td>
                <td className="nowrap">
                  {p.kind === 'time_differs' && <button className="btn small" onClick={() => useTime(p)}>Use Unitrust's time</button>}
                  {(p.kind === 'failed' || p.kind === 'not_sent') && <button className="btn small" onClick={() => retry(p)}>Try again</button>}
                  <button className="btn small" onClick={() => openLead(p.lead_id)}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Settings → Google Calendar. */
export function GoogleCalendarCard() {
  const { toast } = useApp();
  const [s, reload] = useCalendarStatus();
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  useEffect(() => {
    if (s) setClientId(s.client_id ?? '');
  }, [s?.client_id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;

  const saveClient = async () => {
    try {
      await api.put('/calendar/client', { client_id: clientId, client_secret: secret || null });
      setSecret('');
      toast('Saved on this computer');
      await reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const connect = async () => {
    try {
      const r = await api.post<{ url: string }>('/calendar/connect', {});
      window.location.href = r.url;
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const disconnect = async () => {
    if (!window.confirm('Disconnect Google Calendar? New appointments will stop going on your calendar.')) return;
    await api.post('/calendar/disconnect', {});
    setCheck(null);
    await reload();
  };
  const runCheck = async () => {
    setCheck(await api.post<{ ok: boolean; message: string }>('/calendar/check', {}));
    await reload();
  };

  return (
    <div className="card" aria-label="Google Calendar">
      <h2>Google Calendar</h2>
      <p className="help">
        When you set an appointment, the app puts a 30-minute <b>#MP lead-ID LAST-NAME</b> event on your main Google calendar. Unitrust replaces it with
        its own event, and the app then adds your note at the top of Unitrust's event. It never emails the borrower, but a borrower who uses Google
        Calendar may see the note, since they're a guest on that event.
      </p>
      {s.connected ? (
        <div className="row">
          <span className="ok">Connected{s.email ? ` as ${s.email}` : ''}.</span>
          <button className="btn small" onClick={runCheck}>Check connection</button>
          <button className="btn small" onClick={disconnect}>Disconnect</button>
          {!showSetup && <button className="btn small" onClick={() => setShowSetup(true)}>Change Google client</button>}
          {check && <span className={check.ok ? 'ok' : 'error'}>{check.message}</span>}
        </div>
      ) : s.needs_reconnect ? (
        <div className="row">
          <span className="warn">Google stopped accepting the sign-in{s.reconnect_reason ? ` (${s.reconnect_reason})` : ''}.</span>
          <button className="btn small primary" onClick={connect}>Connect again</button>
        </div>
      ) : null}
      {s.last_connect_error && <p className="error">{s.last_connect_error}</p>}
      {s.connected && s.last_error && <p className="warn">Last try: {s.last_error}</p>}

      {(!s.connected || showSetup) && (
        <>
          <h3>One-time setup (about 10 minutes)</h3>
          <ol className="help" style={{ fontSize: 13 }}>
            <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer noopener">console.cloud.google.com</a> signed in as the Google account Unitrust uses. Create a project named <b>Mortgage CRM</b>.</li>
            <li>Go to <b>APIs &amp; Services → Library</b>, search <b>Google Calendar API</b>, click <b>Enable</b>.</li>
            <li>Go to <b>Google Auth Platform</b> (or <b>OAuth consent screen</b>) → <b>Get started</b>. App name: Mortgage CRM. Audience: <b>External</b>. Your email for the contact fields. Finish.</li>
            <li>Under <b>Audience</b>, click <b>Publish app</b> so it says <b>In production</b>. Skip this and Google signs you out every 7 days. You don't need Google to verify it.</li>
            <li>Under <b>Clients</b>, click <b>Create client</b>. Application type: <b>Desktop app</b>. Name: Mortgage CRM. Create.</li>
            <li>Copy the <b>Client ID</b> and <b>Client secret</b> into the boxes below and click Save, then <b>Connect to Google</b>.</li>
            <li>Google shows "Google hasn't verified this app". That's expected, because the app is your own: click <b>Advanced → Go to Mortgage CRM</b>, tick the calendar box, and click Continue.</li>
          </ol>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: 2, minWidth: 260 }}>
              <span>Client ID</span>
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}>
              <span>Client secret {s.configured && <em>(saved; type a new one to replace it)</em>}</span>
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
            </label>
            <button className="btn" onClick={saveClient}>Save</button>
            <button className="btn primary" onClick={connect} disabled={!s.configured}>Connect to Google</button>
          </div>
          <p className="help">The secret and the sign-in stay on this computer (in the data folder, readable only by you). They're never shown, exported or put in backups.</p>
        </>
      )}
    </div>
  );
}
