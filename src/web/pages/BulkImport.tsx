import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError, fmtDateTime } from '../api';
import { useApp } from '../App';
import { showImportedLeads } from './LeadsPage';

// Bulk import: many lead files, or a whole folder, in one go. Files are sent one at a time; the app imports each
// spreadsheet as it arrives and reads PDFs a few at a time in the background. Leads that need a look are put
// aside in "Imports to finish"; everything else goes straight in.

/** A file picked for a bulk import, with where it sat in the folder you picked. */
export interface PickedFile {
  file: File;
  path: string;
}

const LEAD_FILE = /\.(pdf|xlsx|xlsm|csv|tsv)$/i;

/** Lead files only: hidden files, Office lock files (~$…) and anything that isn't a PDF or sheet are left out. */
export function leadFilesOnly(files: PickedFile[]) {
  const keep: PickedFile[] = [];
  let skipped = 0;
  for (const f of files) {
    const name = f.file.name;
    if (name.startsWith('.') || name.startsWith('~$') || !LEAD_FILE.test(name)) skipped++;
    else keep.push(f);
  }
  keep.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { files: keep, skipped };
}

export function pickedFromInput(list: FileList | null): PickedFile[] {
  return [...(list ?? [])].map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
}

/** Files and folders dropped on the page, folders read all the way down. */
export async function pickedFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = [...dt.items].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null)).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  const out: PickedFile[] = [];
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      // readEntries hands back a folder a chunk at a time.
      for (;;) {
        const chunk = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!chunk.length) break;
        for (const c of chunk) await walk(c, `${prefix}${e.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const fmtN = (n: number) => n.toLocaleString();

// ---------------------------------------------------------------------------------------------

type FileState = 'queued' | 'reading' | 'needs_columns' | 'needs_review' | 'imported' | 'nothing_new' | 'failed' | 'removed';

interface BulkFile {
  seq: number;
  file_name: string;
  rel_path: string | null;
  part: string | null;
  size_bytes: number | null;
  state: FileState;
  draft_id: string | null;
  batch_id: string | null;
  message: string | null;
  summary: { leads: number; repeats: number; not_imported: number; to_check: number; added_to_call_list: number };
  progress: { phase: string; total: number; text_done: number; ai_total: number; ai_done: number; ai_failed: number } | null;
}

interface BulkTotals {
  files: number;
  waiting: number;
  imported_files: number;
  needs_review_files: number;
  needs_columns_files: number;
  nothing_new_files: number;
  failed_files: number;
  leads: number;
  repeats: number;
  not_imported: number;
  to_check: number;
  added_to_call_list: number;
}

interface BulkStatus {
  id: string;
  created_at: string;
  settings: { lead_type: string | null; add_to_call_list: boolean; import_ready_now: boolean };
  totals: BulkTotals;
  files: BulkFile[];
}

const STATE_TEXT: Record<FileState, string> = {
  queued: 'Waiting to be read', reading: 'Reading pages', needs_columns: 'Columns not matched', needs_review: 'Some to check',
  imported: 'Imported', nothing_new: 'Nothing new', failed: 'Failed', removed: 'Deleted',
};
const STATE_CLASS: Partial<Record<FileState, string>> = { imported: 'ok', needs_review: 'warn', needs_columns: 'warn', failed: 'error' };
const PROBLEM: FileState[] = ['needs_columns', 'needs_review', 'failed'];

/** The options you see after picking files, before anything is sent. */
export function BulkConfirm({ picked, skipped, leadType, onStart, onCancel }: {
  picked: PickedFile[];
  skipped: number;
  leadType: string;
  onStart: (settings: { add_to_call_list: boolean; import_ready_now: boolean }) => void;
  onCancel: () => void;
}) {
  const [toList, setToList] = useState(false);
  const [readyNow, setReadyNow] = useState(true);
  const pdfs = picked.filter((p) => /\.pdf$/i.test(p.file.name)).length;
  const bytes = picked.reduce((a, p) => a + p.file.size, 0);
  return (
    <div className="card">
      <h2>Import {fmtN(picked.length)} files</h2>
      <p>
        {fmtN(pdfs)} PDF{pdfs === 1 ? '' : 's'} and {fmtN(picked.length - pdfs)} spreadsheet{picked.length - pdfs === 1 ? '' : 's'}, {fmtBytes(bytes)} in all.
        {skipped > 0 && <span className="muted"> {fmtN(skipped)} other file{skipped === 1 ? ' was' : 's were'} left out (not a PDF or spreadsheet).</span>}
      </p>
      <ul className="plain help">
        <li>Lead type: <b>{leadType || 'none'}</b> for every file (change it per lead later, on the Leads page or in a file's review).</li>
        <li>Each file becomes its own batch, named after the file. Leads already imported, or repeated across files, are skipped.</li>
        <li>Spreadsheets need columns the app recognises, or that you matched before for the same layout. Ones it can't match are listed at the end.</li>
        <li>Scanned PDF pages are read by the AI you chose in Settings, two files at a time.</li>
      </ul>
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={readyNow} onChange={(e) => setReadyNow(e.target.checked)} />
        Import complete leads straight away, and put the ones that need a look aside to check later
      </label>
      <label className="row" style={{ gap: 6, marginTop: 6 }}>
        <input type="checkbox" checked={toList} onChange={(e) => setToList(e.target.checked)} />
        Add the imported leads to the call list
      </label>
      <p className="help">Off by default for a bulk import: pick who to call from the Leads page instead of adding everyone at once.</p>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" onClick={() => onStart({ add_to_call_list: toList, import_ready_now: readyNow })} disabled={!picked.length}>
          Start importing
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

async function sendFile(bulkId: string, p: PickedFile) {
  const send = () =>
    fetch(`/api/bulk-imports/${bulkId}/files`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(p.file.name),
        'x-file-path': encodeURIComponent(p.path),
        'x-file-modified': String(p.file.lastModified || ''),
      },
      body: p.file,
    });
  let r: Response;
  try {
    r = await send();
  } catch {
    // One retry for a dropped connection (the app restarting, a sleeping laptop).
    await new Promise((res) => setTimeout(res, 2000));
    r = await send();
  }
  if (!r.ok) {
    let msg = `the app answered ${r.status}`;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, r.status);
  }
}

// The files being sent live outside the screen, so you can open a file to check, or go to another page,
// and sending carries on. Only one bulk import sends at a time.
export interface Sending {
  bulkId: string;
  total: number;
  totalBytes: number;
  files: number;
  bytes: number;
  failed: { path: string; error: string }[];
  done: boolean;
  stopped: boolean;
}
let sending: Sending | null = null;
let stopAsked = false;
const listeners = new Set<() => void>();
const setSending = (next: Sending) => {
  sending = next;
  listeners.forEach((l) => l());
};
const warnOnClose = (e: BeforeUnloadEvent) => e.preventDefault();

export function isSending() {
  return !!sending && !sending.done;
}

export function startSending(bulkId: string, files: PickedFile[]) {
  if (isSending()) throw new Error('Another bulk import is still sending files.');
  stopAsked = false;
  setSending({ bulkId, total: files.length, totalBytes: files.reduce((a, p) => a + p.file.size, 0), files: 0, bytes: 0, failed: [], done: false, stopped: false });
  window.addEventListener('beforeunload', warnOnClose);
  void (async () => {
    for (const p of files) {
      if (stopAsked) break;
      let error: string | null = null;
      try {
        await sendFile(bulkId, p);
      } catch (e: any) {
        error = e.message;
      }
      const s = sending!;
      setSending({ ...s, files: s.files + 1, bytes: s.bytes + p.file.size, failed: error ? [...s.failed, { path: p.path, error }] : s.failed });
    }
    window.removeEventListener('beforeunload', warnOnClose);
    setSending({ ...sending!, done: true, stopped: stopAsked });
  })();
}

function useSending(bulkId: string) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => (sending?.bulkId === bulkId ? sending : null),
  );
}

/** Shows how a bulk import is going, file by file. */
export function BulkScreen({ id, onOpenDraft, onBack }: { id: string; onOpenDraft: (draftId: string) => void; onBack: () => void }) {
  const { toast, go } = useApp();
  const [s, setS] = useState<BulkStatus | null>(null);
  const send = useSending(id);
  const isSendingNow = !!send && !send.done;
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const [limit, setLimit] = useState(300);

  const load = useCallback(() => api.get<BulkStatus>(`/bulk-imports/${id}`).then(setS).catch((e) => toast(e.message, 'error')), [id, toast]);
  useEffect(() => void load(), [load, send?.done]);
  const active = isSendingNow || (s?.totals.waiting ?? 0) > 0;
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [active, load]);

  if (!s) return <div className="empty">Loading…</div>;
  const t = s.totals;
  const reading = s.files.filter((f) => f.state === 'reading');
  const shown = s.files.filter((f) => (filter === 'all' ? true : PROBLEM.includes(f.state)));
  const failedSends = send?.failed ?? [];
  const notSent = send ? send.total - send.files : 0;

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Bulk import · {fmtDateTime(s.created_at)}</h2>
          <div className="row">
            {isSendingNow && <button className="btn" onClick={() => (stopAsked = true)}>Stop sending files</button>}
            <button className="btn" onClick={onBack}>Back to Import</button>
          </div>
        </div>
        {send && isSendingNow && (
          <div className="progress-box" role="status">
            <span>Importing files: {fmtN(send.files)} of {fmtN(send.total)} ({fmtBytes(send.bytes)} of {fmtBytes(send.totalBytes)})</span>
            <progress max={send.totalBytes || 1} value={send.bytes} />
            <span className="help">You can use the rest of the app meanwhile, but keep the app window open until every file is sent.</span>
          </div>
        )}
        {!isSendingNow && t.waiting > 0 && (
          <div className="progress-box" role="status">
            <span>Reading PDFs: {fmtN(t.waiting)} file{t.waiting === 1 ? '' : 's'} to go</span>
            {reading.map((f) => (
              <span key={f.seq} className="help">
                {f.file_name}: {f.progress?.phase === 'ai' ? `scanned pages ${f.progress.ai_done + f.progress.ai_failed} of ${f.progress.ai_total}` : `page ${f.progress?.text_done ?? 0} of ${f.progress?.total || '…'}`}
              </span>
            ))}
            <span className="help">This carries on if you leave this screen or close the app; it picks up where it left off.</span>
          </div>
        )}
        {!active && (
          <p className="ok">
            <b>Done.</b> {send?.stopped && notSent > 0 ? `You stopped it with ${fmtN(notSent)} file${notSent === 1 ? '' : 's'} not sent.` : ''}
          </p>
        )}
        <div className="summary-tiles">
          <div><b className="ok">{fmtN(t.leads)}</b>leads imported</div>
          <div><b>{fmtN(t.repeats)}</b>repeats skipped</div>
          <div><b className="error">{fmtN(t.not_imported)}</b>not imported</div>
          <div><b className="warn">{fmtN(t.to_check)}</b>to check</div>
          <div><b>{fmtN(t.files)}</b>files{t.waiting ? ` (${fmtN(t.waiting)} reading)` : ''}</div>
          {t.nothing_new_files > 0 && <div><b>{fmtN(t.nothing_new_files)}</b>files with nothing new</div>}
          {t.needs_columns_files + t.failed_files + failedSends.length > 0 && (
            <div><b className="error">{fmtN(t.needs_columns_files + t.failed_files + failedSends.length)}</b>files not imported</div>
          )}
        </div>
        {t.added_to_call_list > 0 && <p>{fmtN(t.added_to_call_list)} leads were added to your call list.</p>}
        {t.to_check > 0 && (
          <div className="needs-look">
            <b>{fmtN(t.to_check)} lead{t.to_check === 1 ? ' needs' : 's need'} a look</b> (something missing, or a scanned page the AI read). They wait in "Imports to finish" on the Import page, one per file.
          </div>
        )}
        {t.needs_columns_files > 0 && (
          <p className="warn">
            {fmtN(t.needs_columns_files)} spreadsheet{t.needs_columns_files === 1 ? "'s" : "s'"} columns couldn't be matched. Import one of them on its own and match the columns once; the app remembers, so the rest with the same layout then go in with another bulk import.
          </p>
        )}
        {failedSends.length > 0 && (
          <details>
            <summary className="error">{fmtN(failedSends.length)} file{failedSends.length === 1 ? '' : 's'} couldn't be sent</summary>
            <ul className="plain">{failedSends.map((f) => <li key={f.path}>{f.path}: {f.error}</li>)}</ul>
          </details>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="btn primary"
            disabled={!t.leads}
            onClick={() => {
              showImportedLeads({ bulk: id });
              go('leads');
            }}
            title="Opens Leads showing only the leads from this bulk import"
          >
            See the {fmtN(t.leads)} imported leads
          </button>
          {t.repeats + t.not_imported > 0 && (
            <a className="btn" href={`/api/bulk-imports/${id}/problems.csv`} title="Repeats and leads missing details from the files that were imported, with the file each came from">
              Download the leads not imported (CSV)
            </a>
          )}
        </div>
        <p className="help">
          On Leads you can open any lead to check it, narrow it down by county or status, and add them to the call list. Pick a single file with the
          Leads button in the table below.
        </p>
      </div>

      <div className="card">
        <div className="tabs" style={{ marginBottom: 8 }}>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All files ({fmtN(s.files.length)})</button>
          <button className={filter === 'problems' ? 'active' : ''} onClick={() => setFilter('problems')}>
            Need you ({fmtN(s.files.filter((f) => PROBLEM.includes(f.state)).length)})
          </button>
        </div>
        <div style={{ maxHeight: 520, overflow: 'auto' }}>
          <table className="grid">
            <thead><tr><th>File</th><th>Result</th><th>Imported</th><th>Repeats</th><th>Not imported</th><th>To check</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {shown.slice(0, limit).map((f) => (
                <tr key={f.seq}>
                  <td title={f.rel_path ?? f.file_name}>{f.rel_path ?? f.file_name}{f.part && <span className="muted"> · part {f.part}</span>}</td>
                  <td className={STATE_CLASS[f.state] ?? ''}>{STATE_TEXT[f.state]}</td>
                  <td>{fmtN(f.summary.leads)}</td>
                  <td>{fmtN(f.summary.repeats)}</td>
                  <td>{fmtN(f.summary.not_imported)}</td>
                  <td>{f.summary.to_check ? fmtN(f.summary.to_check) : ''}</td>
                  <td className="help">{f.message}</td>
                  <td className="nowrap">
                    {f.state === 'needs_review' && f.draft_id && <button className="btn small primary" onClick={() => onOpenDraft(f.draft_id!)}>Check</button>}
                    {f.batch_id && f.summary.leads > 0 && (
                      <button
                        className="btn small"
                        onClick={() => {
                          showImportedLeads({ batch: f.batch_id! });
                          go('leads');
                        }}
                      >
                        Leads
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > limit && (
            <button className="btn small" onClick={() => setLimit(limit + 500)}>Show more ({fmtN(shown.length - limit)} left)</button>
          )}
        </div>
      </div>
    </>
  );
}

/** Recent bulk imports, on the Import page. */
export function BulkList({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<{ id: string; created_at: string; totals: BulkTotals }[] | null>(null);
  useEffect(() => {
    api.get<typeof rows>('/bulk-imports').then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows?.length) return null;
  return (
    <div className="card">
      <h2>Bulk imports</h2>
      <table className="grid">
        <thead><tr><th>Started</th><th>Files</th><th>Leads imported</th><th>Repeats</th><th>To check</th><th></th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td>{fmtDateTime(b.created_at)}</td>
              <td>{fmtN(b.totals.files)}{b.totals.waiting ? <span className="muted"> ({fmtN(b.totals.waiting)} reading)</span> : null}</td>
              <td>{fmtN(b.totals.leads)}</td>
              <td>{fmtN(b.totals.repeats)}</td>
              <td>{b.totals.to_check ? fmtN(b.totals.to_check) : ''}</td>
              <td><button className="btn small" onClick={() => onOpen(b.id)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
