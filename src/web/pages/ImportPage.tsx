import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, fmtDateTime, fmtMoney, type AddResult } from '../api';
import { useApp } from '../App';
import { DraftScreen, Done } from './DraftScreen';
import { useLeadTypes } from '../leadTypes';
import type { DraftListItem, DraftSummary } from '../importTypes';
import {
  BulkConfirm, BulkScreen, leadFilesOnly, pickedFromDrop, pickedFromInput, startSending, isSending, type PickedFile,
} from './BulkImport';
import { showImportedLeads } from './LeadsPage';
import { ImportHistory } from '../components/BatchBrowse';
import { getStored, setStored } from '../storage';

// Import: a lead PDF (read page by page, scans by AI) or a spreadsheet. Every import goes through a draft
// that is saved as you go: leads that need a look open in the review window, you set lead types,
// then you import. Leaving keeps the draft; it is listed here to finish later.

interface SheetInfo {
  name: string;
  headers: string[];
  header_row: number;
  row_count: number;
  sample: { rowNumber: number; cells: Record<string, string> }[];
  suggested_mapping: Record<string, string>;
  mapping_source: 'saved' | 'guessed';
}
interface ParseResult {
  upload_id: string;
  file_name: string;
  file_previously_imported: { id: string; name: string; imported_at: string }[];
  sheets: SheetInfo[];
}

const DRAFT_KEY = 'mpcrm.import.draft';

const BULK_KEY = 'mpcrm.import.bulk';
function storeBulk(v?: string | null) {
  try {
    if (v === undefined) return sessionStorage.getItem(BULK_KEY);
    if (v === null) sessionStorage.removeItem(BULK_KEY);
    else sessionStorage.setItem(BULK_KEY, v);
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function ImportPage() {
  const [draftId, setDraftId] = useState<string | null>(getStored(DRAFT_KEY));
  // The bulk import you were looking at; checking one of its files comes back here.
  const [bulkId, setBulkId] = useState<string | null>(storeBulk());
  const [done, setDone] = useState<{ batch_id: string; summary: DraftSummary; call_list?: AddResult | null } | null>(null);
  const open = (id: string | null) => {
    setDraftId(id);
    setStored(DRAFT_KEY, id);
  };
  const openBulk = (id: string | null) => {
    setBulkId(id);
    storeBulk(id);
  };
  if (done) return <Done r={done} onAgain={() => setDone(null)} />;
  if (draftId) {
    return (
      <DraftScreen
        key={draftId}
        id={draftId}
        onLeave={() => open(null)}
        onGone={() => open(null)}
        onCommitted={(r) => {
          open(null);
          // From a bulk import, go back to its list of files.
          if (!bulkId) setDone(r);
        }}
      />
    );
  }
  if (bulkId) return <BulkScreen key={bulkId} id={bulkId} onOpenDraft={open} onBack={() => openBulk(null)} />;
  return <Start onDraft={open} onBulk={openBulk} />;
}

// ---------------------------------------------------------------------------------------------

function Start({ onDraft, onBulk }: { onDraft: (id: string) => void; onBulk: (id: string) => void }) {
  const { toast, go } = useApp();
  const { types } = useLeadTypes();
  const [leadType, setLeadType] = useState('');
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [picked, setPicked] = useState<{ files: PickedFile[]; skipped: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  /** One file goes through the usual screens; several (or a folder) make a bulk import. */
  const onPicked = (all: PickedFile[], fromFolder: boolean) => {
    if (fileInput.current) fileInput.current.value = '';
    if (folderInput.current) folderInput.current.value = '';
    if (!all.length) return;
    if (all.length === 1 && !fromFolder) return void onFile(all[0]!.file);
    const r = leadFilesOnly(all);
    if (!r.files.length) return toast('No PDFs or spreadsheets in what you picked.', 'error');
    setPicked(r);
  };

  const startBulk = async (settings: { add_to_call_list: boolean; import_ready_now: boolean }) => {
    if (!picked) return;
    if (isSending()) return toast('Another bulk import is still sending its files. Wait for it to finish, or stop it.', 'error');
    try {
      const b = await api.post<{ id: string }>('/bulk-imports', { lead_type: leadType || null, ...settings });
      startSending(b.id, picked.files);
      setPicked(null);
      onBulk(b.id);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => {
    api.get<{ lead_type: string }>('/import-defaults').then((d) => setLeadType((t) => t || d.lead_type)).catch(() => {}); // only a default; the type can still be picked by hand
  }, []);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        // The lead type may not have loaded yet if a file is picked straight away; the server then uses the default.
        const q = leadType ? `?lead_type=${encodeURIComponent(leadType)}` : '';
        const r = await api.upload<{ id: string }>(`/drafts/pdf${q}`, f, 'application/pdf');
        onDraft(r.id);
      } else {
        setFile(f);
        setParsed(await api.upload<ParseResult>('/imports/parse', f));
      }
    } catch (e: any) {
      toast(e.message, 'error');
      if (fileInput.current) fileInput.current.value = '';
    } finally {
      setBusy(false);
    }
  };

  if (parsed && file) {
    return <MapColumns parsed={parsed} file={file} leadType={leadType} onDraft={onDraft} onBack={() => setParsed(null)} />;
  }
  if (picked) {
    return <BulkConfirm picked={picked.files} skipped={picked.skipped} leadType={leadType} onStart={startBulk} onCancel={() => setPicked(null)} />;
  }

  return (
    <>
      <div
        className={`card${dragging ? ' drop-target' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          const all = await pickedFromDrop(e.dataTransfer);
          onPicked(all, all.some((p) => p.path.includes('/')));
        }}
      >
        <h2>Import leads</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            <span>Lead type for this order</span>
            <select value={leadType} onChange={(e) => setLeadType(e.target.value)}>
              {types.filter((t) => t.active).map((t) => (
                <option key={t.code} value={t.code}>{t.label}{t.price_cents != null ? ` · ${fmtMoney(t.price_cents)}` : ''}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Lead PDFs or spreadsheets (pick one or many)</span>
            <input ref={fileInput} type="file" multiple accept=".pdf,.xlsx,.xlsm,.csv,.tsv,.txt" onChange={(e) => onPicked(pickedFromInput(e.target.files), false)} disabled={busy} />
          </label>
          <button className="btn" onClick={() => folderInput.current?.click()} disabled={busy}>Choose a folder…</button>
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(e) => onPicked(pickedFromInput(e.target.files), true)}
          />
        </div>
        <p className="help">
          A PDF is read page by page: typed pages are read straight from the page, and scanned cards are read by the AI you chose in Settings.
          If an order mixes lead types, you can change the type of any lead before importing. Nothing is added to your leads until you press Import.
        </p>
        <p className="help">
          Lots of files? Pick them all, choose a folder (every file in it and its subfolders), or drop them here. They're imported in one go:
          complete leads go straight in, repeats are skipped, and anything that needs a look waits below.
        </p>
      </div>
      <Drafts onOpen={onDraft} />
      <ImportHistory onOpenBulk={onBulk} onSeeLeads={(what) => { showImportedLeads(what); go('leads'); }} />
    </>
  );
}

function Drafts({ onOpen }: { onOpen: (id: string) => void }) {
  const { toast } = useApp();
  const [list, setList] = useState<DraftListItem[] | null>(null);
  const load = useCallback(() => api.get<DraftListItem[]>('/drafts').then(setList).catch(() => setList([])), []);
  useEffect(() => void load(), [load]);
  if (!list?.length) return null;
  return (
    <div className="card">
      <h2>Imports to finish</h2>
      <table className="grid">
        <thead><tr><th>File</th><th>Started</th><th>Where it's at</th><th></th></tr></thead>
        <tbody>
          {list.map((d) => (
            <tr key={d.id}>
              <td>{d.file_name}</td>
              <td>{fmtDateTime(d.created_at)}</td>
              <td>
                {d.status === 'reading'
                  ? `Reading pages (${d.progress?.text_done ?? 0} of ${d.progress?.total || '?'})`
                  : `${d.counts.needs_review ?? 0} to check · ${(d.counts.auto ?? 0) + (d.counts.ok ?? 0)} ready · ${d.counts.discarded ?? 0} discarded`}
              </td>
              <td className="row">
                <button className="btn small primary" onClick={() => onOpen(d.id)}>Continue</button>
                <button
                  className="btn small danger"
                  onClick={async () => {
                    if (!window.confirm(`Delete the import of ${d.file_name} and everything checked so far?`)) return;
                    await api.del(`/drafts/${d.id}`).catch((e) => toast(e.message, 'error'));
                    void load();
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MapColumns({ parsed, file, leadType, onDraft, onBack }: { parsed: ParseResult; file: File; leadType: string; onDraft: (id: string) => void; onBack: () => void }) {
  const { meta } = useApp();
  const [sheetName, setSheetName] = useState(parsed.sheets[0]!.name);
  const sheet = parsed.sheets.find((s) => s.name === sheetName)!;
  const [mapping, setMapping] = useState<Record<string, string>>(sheet.suggested_mapping);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const go = async () => {
    setBusy(true);
    setProblems([]);
    try {
      const r = await api.post<{ id: string }>('/drafts/sheet', {
        upload_id: parsed.upload_id, sheet: sheetName, mapping: clean(mapping), lead_type: leadType || null, file_modified: file.lastModified || null,
      });
      onDraft(r.id);
    } catch (e) {
      if (e instanceof ApiError) setProblems(e.problems.length ? e.problems : [e.message]);
      else setProblems([String(e)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Match the columns of {parsed.file_name}</h2>
      {parsed.file_previously_imported.length > 0 && (
        <p className="warn">
          This exact file was imported before ({parsed.file_previously_imported.map((b) => `${b.name}, ${fmtDateTime(b.imported_at)}`).join('; ')}). Leads already imported will be skipped.
        </p>
      )}
      <div className="row">
        {parsed.sheets.length > 1 && (
          <label className="field">
            <span>Sheet</span>
            <select value={sheetName} onChange={(e) => {
              const s = parsed.sheets.find((x) => x.name === e.target.value)!;
              setSheetName(s.name);
              setMapping(s.suggested_mapping);
            }}>
              {parsed.sheets.map((s) => <option key={s.name}>{s.name}</option>)}
            </select>
          </label>
        )}
        <span className="muted">
          {sheet.row_count} rows, headers on row {sheet.header_row}. {sheet.mapping_source === 'saved' ? 'Using the matches you saved for this layout.' : 'Matches were guessed from the headers; check them.'}
        </span>
      </div>
      <table className="grid" style={{ marginTop: 8 }}>
        <thead><tr><th>Field</th><th>Column in your file</th><th>Sample values</th></tr></thead>
        <tbody>
          {meta?.lead_fields.map((f) => {
            const col = mapping[f.key] ?? '';
            return (
              <tr key={f.key}>
                <td>{f.label}{f.key === 'phone' && ' *'}</td>
                <td>
                  <select value={col} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })} aria-label={`Column for ${f.label}`}>
                    <option value="">(not in file)</option>
                    {sheet.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </td>
                <td className="muted">{col ? sheet.sample.map((r) => r.cells[col]).filter(Boolean).slice(0, 3).join(' · ') : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="help">
        * Required, plus a name. Columns you don't match are still saved with each lead. A Status column becomes call history, dated "on or before" the day the file was last saved.
      </p>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" onClick={go} disabled={busy}>Continue</button>
        <button className="btn" onClick={onBack} disabled={busy}>Choose another file</button>
      </div>
      {problems.length > 0 && <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
    </div>
  );
}

function clean(m: Record<string, string>) {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v));
}
