import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { useApp } from '../App';

// Settings → Backups: back up now, the weekly restore check, and the backups kept.

export function BackupsCard() {
  const { meta, toast } = useApp();
  const [backups, setBackups] = useState<{ file: string; bytes: number; created_at: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ at: string; file: string | null; ok: boolean | null; message: string } | null>(null);
  useEffect(() => void api.get<typeof check>('/backups/check').then(setCheck).catch(() => {}), []); // only a status line; the backup buttons still work
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
    <div className="card" id="backups">
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
  );
}

/** Settings → Backups: your setup (not your leads) as one file, to keep or to load on another computer. */
export function SetupCard() {
  const { toast, reloadMeta } = useApp();
  const [busy, setBusy] = useState(false);
  const load = async (file: File | undefined) => {
    if (!file) return;
    if (!window.confirm(`Load the setup in "${file.name}"? Your smart lists, buttons, rules, tag shortcuts, funnel steps, calling settings and report layouts are replaced by the file's. Tags and fields are added; nothing is deleted, and leads and calls stay as they are.`)) return;
    setBusy(true);
    try {
      let body: unknown;
      try {
        body = JSON.parse(await file.text());
      } catch {
        throw new Error("that file isn't a setup file");
      }
      const r = await api.post<{ tags_added: number; fields_added: number }>('/setup', body);
      await reloadMeta();
      toast(`Setup loaded: ${r.tags_added} new tag${r.tags_added === 1 ? '' : 's'}, ${r.fields_added} new field${r.fields_added === 1 ? '' : 's'}`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" id="setup-file">
      <h2>Your setup</h2>
      <p className="help">
        Everything you've set up, as one file: tags, fields, smart lists, buttons, rules, tag shortcuts, funnel steps, calling
        settings and report layouts. No leads, calls or keys. Save it to keep a copy, or load it on another computer.
        Loading one checks it all first: if anything in it doesn't work here, nothing changes and you're told what.
      </p>
      <div className="row">
        <a className="btn" href="/api/setup/file">Save my setup</a>
        <label className="btn">
          Load a setup…
          <input type="file" accept=".json,application/json" hidden disabled={busy} aria-label="Load a setup file"
            onChange={(e) => { void load(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
    </div>
  );
}
