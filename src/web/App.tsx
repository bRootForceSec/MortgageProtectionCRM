import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Meta } from './api';
import { CallingPage } from './pages/CallingPage';
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
  useEffect(() => {
    api.get<CallingSettingsResponse>('/settings/calling').then(setCalling).catch(() => {});
  }, []);
  const keys = useMemo(() => buildKeyMap(calling, meta?.outcome_codes ?? []), [calling, meta]);

  const reloadMeta = useCallback(async () => {
    try {
      setMeta(await api.get<Meta>('/meta'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthError(e.message);
    }
  }, []);
  useEffect(() => void reloadMeta(), [reloadMeta]);
  useEffect(() => {
    const f = () => setPage(pageFromHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  const toast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), kind === 'error' ? 6000 : 2500);
  }, []);
  const go = (p: Page) => {
    location.hash = p;
    setPage(p);
  };
  const openLead = useCallback((leadId: string) => {
    try {
      localStorage.setItem('mpcrm.selectedLead', leadId);
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new CustomEvent('mpcrm:open-lead', { detail: leadId }));
    location.hash = 'calling';
    setPage('calling');
  }, []);

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
}

function TodayStats() {
  const { statsVersion, calling } = useApp();
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);
    api.get<Stats>('/stats/today', { from: start.toISOString(), to: end.toISOString() }).then(setS).catch(() => {});
  }, [statsVersion, calling]);
  if (!s) return null;
  const g = s.goals ?? { dials: null, contacts: null, appointments: null };
  const Goal = ({ label, n, goal }: { label: string; n: number; goal: number | null }) => (
    <span className={goal && n >= goal ? 'goal-met' : ''}>
      {label} <b>{n}</b>{goal ? <span className="muted"> / {goal}</span> : null}
    </span>
  );
  return (
    <div className="stats" title="Today, from your logged calls. Set daily goals in Settings.">
      <Goal label="Dials" n={s.dials} goal={g.dials} />
      <span>Calls <b>{s.attempts}</b></span>
      <span>Leads <b>{s.unique_leads}</b></span>
      <Goal label="Contacts" n={s.human_contacts} goal={g.contacts} />
      <span>Callbacks <b>{s.callbacks}</b></span>
      <Goal label="Appointments" n={s.appointments} goal={g.appointments} />
    </div>
  );
}
