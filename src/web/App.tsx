import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, type Meta } from './api';
import { CallingPage } from './pages/CallingPage';
import { ImportPage } from './pages/ImportPage';
import { LeadsPage } from './pages/LeadsPage';
import { CallsPage } from './pages/CallsPage';
import { NumbersPage } from './pages/NumbersPage';
import { DataPage } from './pages/DataPage';
import { UpdateBar } from './components/UpdateBar';

type Page = 'calling' | 'import' | 'leads' | 'calls' | 'numbers' | 'data';
const PAGES: { key: Page; label: string }[] = [
  { key: 'calling', label: 'Calling' },
  { key: 'leads', label: 'Leads' },
  { key: 'calls', label: 'Call history' },
  { key: 'import', label: 'Import' },
  { key: 'numbers', label: 'Numbers' },
  { key: 'data', label: 'Export & backup' },
];

interface Ctx {
  meta: Meta | null;
  reloadMeta: () => Promise<void>;
  toast: (msg: string, kind?: 'ok' | 'error') => void;
  go: (p: Page) => void;
  statsVersion: number;
  bumpStats: () => void;
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
    <AppCtx.Provider value={{ meta, reloadMeta, toast, go, statsVersion, bumpStats: () => setStatsVersion((v) => v + 1) }}>
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
          {page === 'import' && <ImportPage />}
          {page === 'leads' && <LeadsPage />}
          {page === 'calls' && <CallsPage />}
          {page === 'numbers' && <NumbersPage />}
          {page === 'data' && <DataPage />}
        </div>
        {toastMsg && <div className={`toast ${toastMsg.kind === 'error' ? 'error' : ''}`} role="status">{toastMsg.msg}</div>}
      </div>
    </AppCtx.Provider>
  );
}

function TodayStats() {
  const { statsVersion } = useApp();
  const [s, setS] = useState<{ attempts: number; unique_leads: number; human_contacts: number; appointments: number; callbacks: number } | null>(null);
  useEffect(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);
    api.get<typeof s>('/stats/today', { from: start.toISOString(), to: end.toISOString() }).then(setS).catch(() => {});
  }, [statsVersion]);
  if (!s) return null;
  return (
    <div className="stats" title="Today, from your logged calls">
      <span>Calls <b>{s.attempts}</b></span>
      <span>Leads <b>{s.unique_leads}</b></span>
      <span>Contacts <b>{s.human_contacts}</b></span>
      <span>Callbacks <b>{s.callbacks}</b></span>
      <span>Appointments <b>{s.appointments}</b></span>
    </div>
  );
}
