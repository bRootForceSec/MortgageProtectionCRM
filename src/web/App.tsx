import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Meta } from './api';
import { CallingPage, OPENED_KEY } from './pages/CallingPage';
import { ImportPage } from './pages/ImportPage';
import { LeadsPage } from './pages/LeadsPage';
import { CallsPage } from './pages/CallsPage';
import { NumbersPage } from './pages/NumbersPage';
import { DataPage } from './pages/DataPage';
import { SettingsPage } from './pages/SettingsPage';
import { TodayPage } from './pages/TodayPage';
import { ReportsPage } from './pages/ReportsPage';
import { UpdateBar } from './components/UpdateBar';
import { CallbackAlerts } from './components/CallbackAlerts';
import { buildKeyMap, type CallingSettingsResponse, type KeyMap } from './shortcuts';
import { getStored, getStoredJson, setStored, setStoredJson } from './storage';
import { todayRange, ymd } from './when';
import { FUNNEL_LABEL } from '../shared/funnel';
import { leadIdInText } from '../shared/leadLink';

export type Page = 'calling' | 'today' | 'reports' | 'import' | 'leads' | 'calls' | 'numbers' | 'data' | 'settings';
const PAGES: { key: Page; label: string }[] = [
  { key: 'calling', label: 'Calling' },
  { key: 'today', label: 'Today' },
  { key: 'reports', label: 'Reports' },
  { key: 'leads', label: 'Leads' },
  { key: 'calls', label: 'Call history' },
  { key: 'import', label: 'Import' },
  { key: 'numbers', label: 'Numbers' },
  { key: 'data', label: 'Export & backup' },
  { key: 'settings', label: 'Settings' },
];

interface Ctx {
  meta: Meta | null;
  reloadMeta: () => Promise<void>;
  toast: (msg: string, kind?: 'ok' | 'error') => void;
  go: (p: Page) => void;
  statsVersion: number;
  bumpStats: () => void;
  calling: CallingSettingsResponse | null;
  setCalling: (c: CallingSettingsResponse) => void;
  keys: KeyMap;
  /** Opens a lead on the Calling page. */
  openLead: (leadId: string) => void;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

function pageFromHash(): Page {
  const h = location.hash.replace('#', '') as Page;
  return PAGES.some((p) => p.key === h) ? h : 'calling';
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash());
  const [meta, setMeta] = useState<Meta | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [toastMsg, setToast] = useState<{ msg: string; kind: 'ok' | 'error' } | null>(null);
  const [statsVersion, setStatsVersion] = useState(0);
  const [calling, setCalling] = useState<CallingSettingsResponse | null>(null);
  const keys = useMemo(() => buildKeyMap(calling, meta?.outcome_codes ?? []), [calling, meta]);

  const reloadMeta = useCallback(async () => {
    try {
      setMeta(await api.get<Meta>('/meta'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthError(e.message);
    }
  }, []);
  useEffect(() => void reloadMeta(), [reloadMeta]);

  const toast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), kind === 'error' ? 6000 : 2500);
  }, []);
  useEffect(() => {
    api.get<CallingSettingsResponse>('/settings/calling').then(setCalling).catch((e: Error) => toast(`Couldn't load calling settings: ${e.message}`, 'error'));
  }, [toast]);
  const go = (p: Page) => {
    location.hash = p;
    setPage(p);
  };
  const openLead = useCallback((leadId: string) => {
    // Shown beside your calling list without changing it; "Back to list" returns to the lead you were on.
    const was = getStored('mpcrm.selectedLead');
    const prev = getStoredJson<{ leadId: string; backTo: string | null }>(OPENED_KEY);
    const backTo = prev && prev.leadId === was ? prev.backTo : was;
    setStoredJson(OPENED_KEY, { leadId, backTo: backTo === leadId ? null : backTo });
    setStored('mpcrm.selectedLead', leadId);
    window.dispatchEvent(new CustomEvent('mpcrm:open-lead', { detail: leadId }));
    location.hash = 'calling';
    setPage('calling');
  }, []);

  // #lead/<id>: a lead link (shared/leadLink.ts) opens that lead on the Calling page.
  useEffect(() => {
    const f = () => {
      const leadId = leadIdInText(location.hash);
      if (leadId) openLead(leadId);
      else setPage(pageFromHash());
    };
    f();
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, [openLead]);

  if (authError) {
    return (
      <div className="empty">
        <h2>Open the app from its start link</h2>
        <p>{authError}</p>
        <p className="help">Open "Mortgage Protection CRM" from your app menu. If you started it with npm start, use the link printed in the terminal (it looks like http://127.0.0.1:5170/?t=…).</p>
      </div>
    );
  }

  return (
    <AppCtx.Provider value={{ meta, reloadMeta, toast, go, statsVersion, bumpStats: () => setStatsVersion((v) => v + 1), calling, setCalling, keys, openLead }}>
      <div className="app">
        <div className="topbar">
          <span className="brand">Calling CRM</span>
          <nav>
            {PAGES.map((p) => (
              <button key={p.key} className={page === p.key ? 'active' : ''} onClick={() => go(p.key)}>
                {p.label}
              </button>
            ))}
          </nav>
          <TodayStats />
        </div>
        <UpdateBar />
        <div className="page" style={page === 'calling' ? { padding: 0, overflow: 'hidden' } : undefined}>
          {page === 'calling' && <CallingPage />}
          {page === 'today' && <TodayPage />}
          {page === 'reports' && <ReportsPage />}
          {page === 'import' && <ImportPage />}
          {page === 'leads' && <LeadsPage />}
          {page === 'calls' && <CallsPage />}
          {page === 'numbers' && <NumbersPage />}
          {page === 'data' && <DataPage />}
          {page === 'settings' && <SettingsPage />}
        </div>
        <CallbackAlerts />
        {toastMsg && <div className={`toast ${toastMsg.kind === 'error' ? 'error' : ''}`} role="status">{toastMsg.msg}</div>}
      </div>
    </AppCtx.Provider>
  );
}

interface Stats {
  attempts: number;
  dials: number;
  unique_leads: number;
  human_contacts: number;
  appointments: number;
  callbacks: number;
  goals: { dials: number | null; contacts: number | null; appointments: number | null };
  /** How today's Unitrust appointments went (null until the extension has sent any). */
  appts: { appointments: number; sat: number; prezis: number; sold: number; no_show: number; rescheduled: number; pending: number } | null;
}

function TodayStats() {
  const { statsVersion, calling } = useApp();
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    const load = () => api.get<Stats>('/stats/today', { ...todayRange(), day: ymd(new Date()) }).then(setS).catch(() => {}); // refreshed often; the last numbers stay up until the next one works
    void load();
    // Unitrust results arrive from the extension, not from this window, so look again every minute.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [statsVersion, calling]);
  if (!s) return null;
  const g = s.goals ?? { dials: null, contacts: null, appointments: null };
  const Goal = ({ label, n, goal }: { label: string; n: number; goal: number | null }) => (
    <span className={goal && n >= goal ? 'goal-met' : ''}>
      {label} <b>{n}</b>{goal ? <span className="muted"> / {goal}</span> : null}
    </span>
  );
  return (
    <div className="stats" title="Today: dials, leads called, pickups and appointments set, from your logged calls. Set daily goals in Settings.">
      {/* The same four steps as the funnel on the Calling screen. */}
      <Goal label={FUNNEL_LABEL.dials} n={s.dials} goal={g.dials} />
      <span title="People called (one lead can get several dials)">{FUNNEL_LABEL.leads_called} <b>{s.unique_leads}</b></span>
      <Goal label={FUNNEL_LABEL.pickups} n={s.human_contacts} goal={g.contacts} />
      <Goal label={FUNNEL_LABEL.appts_set} n={s.appointments} goal={g.appointments} />
      {/* Only on days with appointments, so it takes no room on a short screen otherwise. */}
      {s.appts && s.appts.appointments > 0 && (
        <span
          className="appt-stats"
          title={`Today's appointments (${s.appts.appointments}): from what you log on the Appointment side, or the Unitrust calendar when the extension sees a change.${s.appts.pending ? ` ${s.appts.pending} not updated yet.` : ''}${s.appts.rescheduled ? ` ${s.appts.rescheduled} rescheduled.` : ''}`}
        >
          <span>{FUNNEL_LABEL.sat} <b>{s.appts.sat}</b></span>
          <span>{FUNNEL_LABEL.prezis} <b>{s.appts.prezis}</b></span>
          <span>{FUNNEL_LABEL.sales} <b>{s.appts.sold}</b></span>
          <span>No-shows <b>{s.appts.no_show}</b></span>
        </span>
      )}
    </div>
  );
}
