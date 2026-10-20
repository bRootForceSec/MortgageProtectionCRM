import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { useApp } from '../App';
import { UpdatePanel } from '../components/UpdateBar';

const TABLES = [
  ['leads', 'Leads'], ['calls', 'Calls'], ['outcomes', 'Outcomes (every change)'], ['events', 'Raw call events'], ['notes', 'Notes'],
  ['batches', 'Import batches'], ['import_rows', 'Imported rows (incl. rejected)'], ['numbers', 'Caller ID numbers'],
] as const;

export function DataPage() {
  const { meta, toast } = useApp();
  const [health, setHealth] = useState(false);
  const [backups, setBackups] = useState<{ file: string; bytes: number; created_at: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ at: string; file: string | null; ok: boolean | null; message: string } | null>(null);
  useEffect(() => void api.get<typeof check>('/backups/check').then(setCheck).catch(() => {}), []);
  const checkNow = async () => {
    setBusy(true);
    try {
      setCheck(await api.post<typeof check>('/backups/check', {}));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const h = health ? '?health=1' : '';

  const load = () => api.get<typeof backups>('/backups').then(setBackups);
  useEffect(() => void load(), []);

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ file: string; bytes: number }>('/backups', {});
      toast(`Backup saved and verified: ${r.file}`);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Export</h2>
        <label className="row">
          <input type="checkbox" checked={health} onChange={(e) => setHealth(e.target.checked)} />
          Include health and tobacco fields (leave off unless you need them; exported files are not encrypted)
        </label>
        <div className="row" style={{ marginTop: 10 }}>
          <a className="btn primary" href={`/api/export/all.xlsx${h}`}>Everything (Excel, one sheet per table)</a>
          <a className="btn" href="/api/export/dump.json" title="Every table, every column, including health fields">Full JSON dump</a>
        </div>
        <table className="grid" style={{ marginTop: 10 }}>
          <tbody>
            {TABLES.map(([k, label]) => (
              <tr key={k}><td>{label}</td><td><a href={`/api/export/${k}.csv${h}`}>CSV</a></td><td><a href={`/api/export/${k}.xlsx${h}`}>Excel</a></td></tr>
            ))}
          </tbody>
        </table>
        <p className="help">The full JSON dump always includes every field. Treat it like the database itself.</p>
      </div>

      <div className="card">
        <h2>Backups</h2>
        <p className="help">
          Backups are verified copies of the whole database, saved in {meta?.data_dir}/backups. A backup runs every night at 11:30 PM while the app is running (in the desktop app, or once installed with scripts/install.sh on Linux), and before every update.
          To restore one, follow "Backups and restore" in the README. The current database is kept aside, not deleted.
        </p>
        <div className="row">
          <button className="btn primary" onClick={backupNow} disabled={busy}>Back up now</button>
          <button className="btn" onClick={checkNow} disabled={busy || !backups.length}>Check the newest backup restores</button>
        </div>
        <p className={check?.ok === false ? 'warn' : 'help'} aria-label="Restore check">
          {check
            ? <>Restore check {fmtDateTime(check.at)}{check.file ? ` (${check.file})` : ''}: {check.ok ? '✓ ' : ''}{check.message}</>
            : 'Once a week the app restores the newest backup into a scratch copy to make sure it works. It hasn\'t run yet.'}
        </p>
        <table className="grid" style={{ marginTop: 10 }}>
          <thead><tr><th>File</th><th>Created</th><th>Size</th></tr></thead>
          <tbody>
            {backups.map((b) => <tr key={b.file}><td>{b.file}</td><td>{fmtDateTime(b.created_at)}</td><td>{(b.bytes / 1024).toFixed(0)} KB</td></tr>)}
          </tbody>
        </table>
        {backups.length === 0 && <div className="empty">No backups yet.</div>}
      </div>

      <UpdatePanel />
    </>
  );
}
