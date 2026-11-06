import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { useApp } from '../App';
import type { CalendarSyncResult, GoogleCalendarSettings, GoogleCalendarStatus } from '../../shared/googleCalendar';

// Settings → Google Calendar: your Google key, signing in, which calendar, and Sync now. Each lead's upcoming
// appointment goes on the calendar as "#MP <Lead ID> <Last name>" (unless it's there already) and moves when it moves.

export function GoogleCalendarCard() {
  const { toast } = useApp();
  const [v, setV] = useState<GoogleCalendarStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [calendars, setCalendars] = useState<{ id: string; name: string; primary: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = useRef<ReturnType<typeof setInterval> | null>(null);
  const load = useCallback(() => api.get<GoogleCalendarStatus>('/google').then(setV).catch((e: Error) => toast(e.message, 'error')), [toast]);
  useEffect(() => {
    void load();
    return () => { if (waiting.current) clearInterval(waiting.current); };
  }, [load]);
  const connected = !!v?.connected;
  useEffect(() => {
    if (!connected) return;
    api.get<{ calendars: typeof calendars }>('/google/calendars').then((r) => setCalendars(r.calendars), (e: Error) => toast(`Couldn't load your calendars: ${e.message}`, 'error'));
  }, [connected, toast]);
  if (!v) return null;

  const run = async <T,>(what: () => Promise<T>, done?: string): Promise<T | null> => {
    setBusy(true);
    try {
      const r = await what();
      if (done) toast(done);
      return r;
    } catch (e) {
      toast((e as Error).message, 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const saveKey = async () => {
    const r = await run(() => api.put<GoogleCalendarStatus>('/google/client', { client_id: clientId, client_secret: secret }), 'Google key saved');
    if (r) { setV(r); setClientId(''); setSecret(''); }
  };
  const connect = async () => {
    const r = await run(() => api.post<{ url: string }>('/google/connect', {}));
    if (!r) return;
    window.open(r.url, '_blank', 'noopener');
    toast('Sign in to Google in the window that opened, then come back here.');
    // Watch for the sign-in to finish, for up to 5 minutes.
    if (waiting.current) clearInterval(waiting.current);
    const until = Date.now() + 5 * 60_000;
    waiting.current = setInterval(() => {
      api.get<GoogleCalendarStatus>('/google').then((s) => {
        if (s.connected || Date.now() > until) {
          if (waiting.current) clearInterval(waiting.current);
          waiting.current = null;
          setV(s);
          if (s.connected) toast('Google Calendar connected');
        }
      }, (e: Error) => toast(e.message, 'error'));
    }, 2_000);
  };
  const saveSettings = async (s: GoogleCalendarSettings) => {
    const r = await run(() => api.put<GoogleCalendarStatus>('/google/settings', s));
    if (r) setV(r);
  };
  const syncNow = async () => {
    const r = await run(() => api.post<{ result: CalendarSyncResult; status: GoogleCalendarStatus }>('/google/sync', {}));
    if (!r) return;
    setV(r.status);
    if (r.result.error) toast(r.result.error, 'error');
    else toast(`Calendar synced: ${r.result.added} added, ${r.result.moved} moved, ${r.result.found} already there`);
  };
  const disconnect = async () => {
    if (!window.confirm('Disconnect Google Calendar? Events already on your calendar stay there.')) return;
    const r = await run(() => api.post<GoogleCalendarStatus>('/google/disconnect', {}), 'Google Calendar disconnected');
    if (r) setV(r);
  };
  const s = v.settings;
  const last = v.last_sync;

  return (
    <div className="card" id="google-calendar">
      <h3>Google Calendar</h3>
      <p className="help">
        Puts each lead's upcoming appointment (from Unitrust, or a time you typed on Appt set) on your Google Calendar as "#MP Lead ID Last name",
        with the lead's phone and a link back to the lead. If you typed it there already, it's left as you wrote it. When an appointment moves, its event
        moves. Nothing is ever deleted from your calendar. It syncs every 15 minutes, and soon after a call or a Unitrust read.
      </p>

      {!v.has_client && (
        <details open>
          <summary>Step 1: make your Google key (once, about 5 minutes)</summary>
          <ol className="help steps">
            <li>Go to <b>console.cloud.google.com</b>, signed in with the Google account whose calendar you use, and make a new project (any name, like "My CRM").</li>
            <li>APIs &amp; Services → Library: find <b>Google Calendar API</b> and press Enable.</li>
            <li>APIs &amp; Services → OAuth consent screen: pick External, fill in the app name and your email, and add yourself under Test users. Then press <b>Publish app</b>, so the sign-in doesn't run out after a week.</li>
            <li>APIs &amp; Services → Credentials → Create credentials → OAuth client ID. Application type: <b>Desktop app</b>. Copy the Client ID and Client secret it shows into the boxes below.</li>
          </ol>
        </details>
      )}
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={v.has_client ? 'New Client ID' : 'Client ID'} aria-label="Google Client ID" style={{ width: 340 }} autoComplete="off" />
        <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder="Client secret" aria-label="Google Client secret" style={{ width: 220 }} autoComplete="off" />
        <button className="btn small" disabled={busy || !clientId.trim() || !secret.trim()} onClick={() => void saveKey()}>{v.has_client ? 'Change key' : 'Save key'}</button>
        {v.has_client && <span className="muted">Key saved.</span>}
      </div>

      <div className="row" style={{ marginTop: 8, gap: 6 }}>
        {connected
          ? <><span>Connected{v.account ? ` as ${v.account}` : ''}.</span> <button className="btn small" disabled={busy} onClick={() => void disconnect()}>Disconnect</button></>
          : <button className="btn small primary" disabled={busy || !v.has_client} onClick={() => void connect()} title={v.has_client ? undefined : 'Save your Google key first'}>Connect Google</button>}
      </div>

      {connected && (
        <div className="row" style={{ marginTop: 8, gap: 10, flexWrap: 'wrap' }}>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void saveSettings({ ...s, enabled: e.target.checked })} />
            Put appointments on my calendar
          </label>
          <select value={s.calendar_id} disabled={busy || !calendars} aria-label="Calendar" onChange={(e) => void saveSettings({ ...s, calendar_id: e.target.value })}>
            {!calendars?.some((c) => (c.primary ? 'primary' : c.id) === s.calendar_id) && <option value={s.calendar_id}>{s.calendar_id === 'primary' ? 'Main calendar' : s.calendar_id}</option>}
            {calendars?.map((c) => <option key={c.id} value={c.primary ? 'primary' : c.id}>{c.name}{c.primary ? ' (main)' : ''}</option>)}
          </select>
          <label className="row" style={{ gap: 4 }}>
            Events last
            <select value={s.duration_min} disabled={busy} aria-label="Event length" onChange={(e) => void saveSettings({ ...s, duration_min: Number(e.target.value) })}>
              {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
            </select>
          </label>
          <button className="btn small" disabled={busy || !s.enabled} onClick={() => void syncNow()}>Sync now</button>
        </div>
      )}
      <p className="help" aria-label="Last Google Calendar sync">
        {last
          ? last.error
            ? <span className="error">Last sync {fmtDateTime(last.at)} stopped: {last.error}</span>
            : <>Last sync {fmtDateTime(last.at)}: {last.checked} upcoming appointment{last.checked === 1 ? '' : 's'}, {last.added} added, {last.moved} moved, {last.found} already on your calendar.</>
          : connected ? 'Not synced yet.' : null}
      </p>
    </div>
  );
}
