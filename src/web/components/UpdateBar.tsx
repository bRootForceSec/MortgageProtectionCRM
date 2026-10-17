import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { useApp } from '../App';

export interface UpdateStatus {
  managed: boolean;
  current: { commit: string; built_at: string | null };
  staged: { commit: string; from: string | null; changes: string[]; at: string } | null;
  last_check: { ok: boolean; error?: string; latest?: string; at: string } | null;
  last_apply: { ok: boolean; from: string | null; to: string; error?: string; rolled_back?: boolean; changes?: string[]; at: string } | null;
}

const short = (c: string | null | undefined) => (c ? c.slice(0, 7) : '—');
const LATER_KEY = 'mpcrm.update.later';
const SEEN_KEY = 'mpcrm.update.seen';

function store(key: string, value?: string) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable; the bar just shows again
  }
  return null;
}

export function useUpdateStatus(pollMs = 5 * 60_000) {
  const [s, setS] = useState<UpdateStatus | null>(null);
  const load = useCallback(() => api.get<UpdateStatus>('/update').then(setS).catch(() => {}), []);
  useEffect(() => {
    void load();
    const t = window.setInterval(load, pollMs);
    window.addEventListener('focus', load);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', load);
    };
  }, [load, pollMs]);
  return { status: s, reload: load };
}

/** Waits for the restarted server to report the new version, then reloads the page. */
async function waitForVersion(commit: string, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      if (r.ok && (await r.json()).commit === commit) return true;
    } catch {
      // restarting
    }
  }
  return false;
}

/** Bar under the top menu: "Update ready", "Updating…", or a failed-update notice. Never restarts on its own. */
export function UpdateBar() {
  const { toast } = useApp();
  const { status, reload } = useUpdateStatus();
  const [later, setLater] = useState(() => store(LATER_KEY));
  const [seen, setSeen] = useState(() => store(SEEN_KEY));
  const [showChanges, setShowChanges] = useState(false);
  const [updating, setUpdating] = useState(false);

  if (!status?.managed) return null;
  const a = status.last_apply;

  if (updating) {
    return <div className="update-bar">Installing the update. The app restarts and this page reloads by itself…</div>;
  }

  if (a && !a.ok && seen !== a.at) {
    return (
      <div className="update-bar bad" role="alert">
        <span>Update to version {short(a.to)} did not work. {a.error}</span>
        <button className="btn small" onClick={() => { store(SEEN_KEY, a.at); setSeen(a.at); }}>OK</button>
      </div>
    );
  }

  const st = status.staged;
  if (!st || later === `${st.commit}:${new Date().toDateString()}`) return null;

  const restart = async () => {
    setUpdating(true);
    try {
      await api.post('/update/apply', {});
    } catch (e: any) {
      setUpdating(false);
      toast(e.message, 'error');
      return;
    }
    if (await waitForVersion(st.commit)) {
      location.reload();
    } else {
      // Rolled back or still starting: show whatever the updater recorded.
      setUpdating(false);
      await reload();
    }
  };

  return (
    <div className="update-bar" role="status">
      <span>
        <b>Update ready.</b> {st.changes.length ? `${st.changes.length} change${st.changes.length === 1 ? '' : 's'}.` : ''}{' '}
        It installs itself at 3 AM if you leave it.
      </span>
      {st.changes.length > 0 && (
        <button className="btn small" onClick={() => setShowChanges((v) => !v)}>{showChanges ? 'Hide' : "What's new"}</button>
      )}
      <button className="btn small primary" onClick={restart}>Restart now</button>
      <button
        className="btn small"
        onClick={() => {
          const v = `${st.commit}:${new Date().toDateString()}`;
          store(LATER_KEY, v);
          setLater(v);
        }}
      >
        Later
      </button>
      {showChanges && (
        <ul className="update-changes">
          {st.changes.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Version and update details for the Export & backup page. */
export function UpdatePanel() {
  const { toast } = useApp();
  const { status, reload } = useUpdateStatus(30_000);
  if (!status) return null;
  const check = async () => {
    try {
      await api.post('/update/check', {});
      toast('Checking for updates. The bar appears at the top when one is ready.');
      window.setTimeout(reload, 5000);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="card">
      <h2>Version and updates</h2>
      <p>
        Version <b>{short(status.current.commit)}</b>
        {status.current.built_at && <> · built {fmtDateTime(status.current.built_at)}</>}
      </p>
      {!status.managed ? (
        <p className="help">This copy was started by hand, so it doesn't update itself. Run <code>bash scripts/install.sh</code> once to install the self-updating version.</p>
      ) : (
        <>
          <p className="help">
            {status.last_check
              ? status.last_check.ok
                ? `Last checked ${fmtDateTime(status.last_check.at)}.`
                : `Last check ${fmtDateTime(status.last_check.at)} failed: ${status.last_check.error}`
              : 'Not checked yet.'}{' '}
            {status.staged ? `Version ${short(status.staged.commit)} is ready to install.` : ''}
          </p>
          {status.last_apply && (
            <p className="help">
              Last update {fmtDateTime(status.last_apply.at)}: {status.last_apply.ok ? `installed version ${short(status.last_apply.to)}.` : status.last_apply.error}
            </p>
          )}
          <button className="btn" onClick={check}>Check now</button>
        </>
      )}
    </div>
  );
}
