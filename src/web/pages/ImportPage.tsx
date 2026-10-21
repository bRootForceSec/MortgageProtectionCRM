import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, fmtDateTime, fmtMoney, fmtPhone, type AddResult } from '../api';
import { useApp } from '../App';
import { ReviewWindow } from '../components/ReviewWindow';
import type { DraftListItem, DraftView, DraftRow, LeadType, DraftSummary } from '../importTypes';
import {
  BulkConfirm, BulkList, BulkScreen, leadFilesOnly, pickedFromDrop, pickedFromInput, startSending, isSending, type PickedFile,
} from './BulkImport';
import { showImportedLeads } from './LeadsPage';
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

export function useLeadTypes() {
  const { toast } = useApp();
  const [types, setTypes] = useState<LeadType[]>([]);
  const reload = useCallback(
    () => api.get<LeadType[]>('/lead-types').then(setTypes).catch((e: Error) => toast(`Couldn't load lead types: ${e.message}`, 'error')),
    [toast],
  );
  useEffect(() => void reload(), [reload]);
  return { types, reload };
}

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
  const { toast } = useApp();
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
        const r = await api.upload<{ id: string }>(`/drafts/pdf?lead_type=${encodeURIComponent(leadType)}`, f, 'application/pdf');
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
      <BulkList onOpen={onBulk} />
      <Drafts onOpen={onDraft} />
      <BatchList />
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

// ---------------------------------------------------------------------------------------------

const RESULT_TEXT: Record<string, string> = {
  accepted: 'Will import', rejected: 'Not importing', duplicate_in_file: 'Repeat in this file', already_imported: 'Already imported',
};
const REVIEW_TEXT: Record<DraftRow['review'], string> = { auto: 'Read fine', needs_review: 'Needs a look', ok: 'Checked', discarded: 'Discarded' };

function DraftScreen({ id, onLeave, onGone, onCommitted }: {
  id: string;
  onLeave: () => void;
  onGone: () => void;
  onCommitted: (r: { batch_id: string; summary: DraftSummary; call_list?: AddResult | null }) => void;
}) {
  const { toast } = useApp();
  const { types } = useLeadTypes();
  const [v, setV] = useState<DraftView | null>(null);
  const [review, setReview] = useState<{ rows: number[]; start: number } | null>(null);
  const [filter, setFilter] = useState<'all' | 'look' | 'out'>('all');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const lastClicked = useRef<number | null>(null);
  const [setTo, setSetTo] = useState('');
  const [byCounty, setByCounty] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [batch, setBatch] = useState({ name: '', purchased_count: '', cost_total: '', notes: '' });
  /** New imports go straight onto the call list unless you untick this. */
  const [toList, setToList] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  /** Rows drawn in the table; a big sheet shows more on request instead of freezing the page. */
  const [limit, setLimit] = useState(500);

  const load = useCallback(async () => {
    try {
      const d = await api.get<DraftView>(`/drafts/${id}`);
      if (d.status === 'committed') {
        onGone();
        return null;
      }
      setV(d);
      return d;
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 404) {
        toast('That import is no longer here.', 'error');
        onGone();
      } else toast(e.message, 'error');
      return null;
    }
  }, [id, toast, onGone]);

  useEffect(() => void load(), [load]);
  // While pages are being read, keep the screen up to date.
  useEffect(() => {
    if (v?.status !== 'reading') return;
    const t = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(t);
  }, [v?.status, load]);
  useEffect(() => {
    if (v && !batch.name) setBatch((b) => ({ ...b, name: v.file_name.replace(/\.(pdf|xlsx|xlsm|csv|tsv|txt)$/i, '') }));
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps

  const prices = useMemo(() => new Map(types.map((t) => [t.code, t.price_cents])), [types]);
  if (!v) return <div className="empty">Loading…</div>;

  const reading = v.status === 'reading';
  const p = v.progress;
  const toCheck = v.rows.filter((r) => r.review === 'needs_review' && r.extractor !== 'pending').map((r) => r.row_number);
  const defaultType = v.settings.default_lead_type ?? null;
  const typeOf = (r: DraftRow) => r.lead_type ?? defaultType;
  const willImport = v.rows.filter((r) => r.status === 'accepted');
  const priced = willImport.map((r) => (typeOf(r) ? prices.get(typeOf(r)!) ?? null : null));
  const costFromTypes = priced.length && priced.every((x) => x != null) ? priced.reduce((a, b) => a! + b!, 0) : null;
  const label = (r: DraftRow) => (v.kind === 'sheet' ? `Row ${r.row_number}` : `Page ${r.page}`);
  const shown = v.rows.filter((r) =>
    filter === 'all' ? true : filter === 'look' ? r.review === 'needs_review' : r.status !== 'accepted',
  );

  const setType = async (sel: Record<string, unknown>, code: string) => {
    try {
      const r = await api.post<{ updated: number }>(`/drafts/${id}/type`, { lead_type: code || null, ...sel });
      toast(`Lead type set on ${r.updated} lead${r.updated === 1 ? '' : 's'}`);
      setChecked(new Set());
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const setDefault = async (code: string) => {
    await api.post(`/drafts/${id}/settings`, { default_lead_type: code || null }).catch((e) => toast(e.message, 'error'));
    await load();
  };

  const toggle = (n: number, shift: boolean) => {
    const next = new Set(checked);
    const on = !next.has(n);
    if (shift && lastClicked.current != null) {
      const nums = shown.map((r) => r.row_number);
      const [a = 0, b = 0] = [nums.indexOf(lastClicked.current), nums.indexOf(n)].sort((x, y) => x - y);
      for (const k of nums.slice(a, b + 1)) {
        if (on) next.add(k);
        else next.delete(k);
      }
    } else if (on) next.add(n);
    else next.delete(n);
    lastClicked.current = n;
    setChecked(next);
  };

  const commit = async () => {
    setBusy(true);
    setProblems([]);
    try {
      const cents = (s: string) => (s.trim() ? Math.round(Number(s.replace(/[$,]/g, '')) * 100) : null);
      const r = await api.post<{ batch_id: string; summary: DraftSummary; call_list: AddResult | null }>(`/drafts/${id}/commit`, {
        add_to_call_list: toList,
        batch: {
          name: batch.name,
          purchased_count: batch.purchased_count ? Number(batch.purchased_count) : null,
          cost_total_cents: cents(batch.cost_total),
          lead_type: defaultType,
          notes: batch.notes || null,
        },
      });
      toast(`Imported ${r.summary.accepted} leads`);
      onCommitted(r);
    } catch (e) {
      if (e instanceof ApiError) setProblems(e.problems.length ? e.problems : [e.message]);
      else setProblems([String(e)]);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!window.confirm('Delete this import and everything checked so far?')) return;
    await api.del(`/drafts/${id}`).catch((e) => toast(e.message, 'error'));
    onGone();
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{v.file_name}</h2>
          <div className="row">
            <button className="btn" onClick={onLeave}>Finish later</button>
            <button className="btn danger" onClick={del}>Delete this import</button>
          </div>
        </div>
        {reading && p && (
          <div className="progress-box" role="status">
            {p.phase === 'text' ? (
              <>Reading pages: {p.text_done} of {p.total || '…'}</>
            ) : (
              <>Reading scanned pages{p.reader ? ` with ${readerName(p.reader)}` : ''}: {p.ai_done + p.ai_failed} of {p.ai_total}</>
            )}
            <progress max={p.phase === 'text' ? p.total || 1 : p.ai_total || 1} value={p.phase === 'text' ? p.text_done : p.ai_done + p.ai_failed} />
            <span className="help">You can check leads that are ready while the rest are read, or leave and come back.</span>
          </div>
        )}
        {!reading && p?.error && <p className="error">Reading stopped: {p.error}</p>}
        {!reading && p && p.ai_total > 0 && (
          <p className="help">
            {p.ai_total} scanned page{p.ai_total === 1 ? ' was' : 's were'} read by {readerName(p.reader)}
            {p.ai_failed ? `; ${p.ai_failed} couldn't be read` : ''}
            {p.cost_usd ? ` (about $${p.cost_usd.toFixed(3)} of your Claude usage)` : ''}.
            {p.ai_failed > 0 && (
              <> <button className="btn small" onClick={async () => { await api.post(`/drafts/${id}/retry`, {}); await load(); }}>Try those pages again</button></>
            )}
          </p>
        )}
        {toCheck.length > 0 && (
          <div className="needs-look">
            <b>{toCheck.length} lead{toCheck.length === 1 ? ' needs' : 's need'} a look</b> before importing (something is missing, or the AI wasn't sure).
            <button className="btn primary" onClick={() => setReview({ rows: toCheck, start: 0 })}>Check {toCheck.length === 1 ? 'it' : 'them'} now</button>
          </div>
        )}
        <SummaryTiles s={v.summary} />
        <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
          <div>
            <h3 className="subhead">By county</h3>
            <ul className="plain">{v.summary.by_county.map((c) => <li key={c.county_key ?? 'none'}>{c.county}: <b>{c.count}</b></li>)}</ul>
          </div>
          <div>
            <h3 className="subhead">By lead type</h3>
            <ul className="plain">{v.summary.by_type.map((t) => <li key={t.lead_type ?? 'none'}>{t.lead_type ?? 'No type'}: <b>{t.count}</b>{t.lead_type && prices.get(t.lead_type) != null && <span className="muted"> × {fmtMoney(prices.get(t.lead_type)!)}</span>}</li>)}</ul>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Lead types</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            <span>Type for this order</span>
            <select value={defaultType ?? ''} onChange={(e) => setDefault(e.target.value)}>
              {types.filter((t) => t.active).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </label>
          <span className="help" style={{ maxWidth: 360 }}>Every lead gets this type unless you change it below. Mixed order? Tick leads in the table (shift-click for a range), or pick a county or pages.</span>
        </div>
        <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <label className="field">
            <span>Change to</span>
            <select value={setTo} onChange={(e) => setSetTo(e.target.value)}>
              <option value="">Choose a type…</option>
              {types.filter((t) => t.active).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </label>
          <button className="btn" disabled={!setTo || checked.size === 0} onClick={() => setType({ rows: [...checked] }, setTo)}>
            for {checked.size} ticked lead{checked.size === 1 ? '' : 's'}
          </button>
          <span className="muted">or</span>
          <select value={byCounty} onChange={(e) => setByCounty(e.target.value)} aria-label="County">
            <option value="">a county…</option>
            {v.summary.by_county.filter((c) => c.county_key).map((c) => <option key={c.county_key!} value={c.county_key!}>{c.county}</option>)}
          </select>
          <button className="btn" disabled={!setTo || !byCounty} onClick={() => setType({ county_key: byCounty }, setTo)}>for that county</button>
          <span className="muted">or {v.kind === 'sheet' ? 'rows' : 'pages'}</span>
          <input style={{ width: 64 }} inputMode="numeric" placeholder="from" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <input style={{ width: 64 }} inputMode="numeric" placeholder="to" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          <button className="btn" disabled={!setTo || !range.from || !range.to} onClick={() => setType({ from: Number(range.from), to: Number(range.to) }, setTo)}>for those</button>
        </div>
      </div>

      <div className="card">
        <div className="tabs" style={{ marginBottom: 8 }}>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All ({v.rows.length})</button>
          <button className={filter === 'look' ? 'active' : ''} onClick={() => setFilter('look')}>Needs a look ({toCheck.length})</button>
          <button className={filter === 'out' ? 'active' : ''} onClick={() => setFilter('out')}>Not importing ({v.rows.filter((r) => r.status !== 'accepted').length})</button>
        </div>
        <div style={{ maxHeight: 480, overflow: 'auto' }}>
          <table className="grid">
            <thead>
              <tr>
                <th><input type="checkbox" aria-label="Tick all shown" checked={shown.length > 0 && shown.every((r) => checked.has(r.row_number))} onChange={(e) => setChecked(e.target.checked ? new Set(shown.map((r) => r.row_number)) : new Set())} /></th>
                <th>{v.kind === 'sheet' ? 'Row' : 'Page'}</th><th>Name</th><th>Phone</th><th>County</th><th>Type</th><th>Check</th><th>Result</th><th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((r) => (
                <tr key={r.row_number} className="click" onClick={() => r.extractor !== 'pending' && setReview({ rows: [r.row_number], start: 0 })}>
                  <td onClick={(e) => { e.stopPropagation(); toggle(r.row_number, e.shiftKey); }}>
                    <input type="checkbox" readOnly checked={checked.has(r.row_number)} aria-label={`Tick ${label(r)}`} />
                  </td>
                  <td>{v.kind === 'sheet' ? r.row_number : r.page}</td>
                  <td>{r.extractor === 'pending' ? <span className="muted">reading…</span> : r.name || <span className="muted">(none)</span>}</td>
                  <td className="nowrap">{r.phone ? fmtPhone(r.phone) : r.fields.phone ?? ''}</td>
                  <td>{r.county ?? <span className="warn">unknown</span>}</td>
                  <td>{typeOf(r) ?? ''}{r.lead_type && <span className="muted"> (changed)</span>}</td>
                  <td className={r.review === 'needs_review' ? 'error' : r.review === 'discarded' ? 'muted' : 'ok'}>{REVIEW_TEXT[r.review]}{r.extractor?.startsWith('ai:') ? ' · AI' : ''}</td>
                  <td className={r.status === 'accepted' ? 'ok' : r.status === 'rejected' ? 'error' : 'warn'}>{r.status ? RESULT_TEXT[r.status] : ''}</td>
                  <td className="help">{[...r.issues.filter((i) => i.blocking).map((i) => i.message), ...r.status_notes].slice(0, 2).join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > limit && (
            <button className="btn small" onClick={() => setLimit(limit + 1000)}>Show more ({shown.length - limit} left)</button>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Batch details</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field"><span>Batch name *</span><input value={batch.name} onChange={(e) => setBatch({ ...batch, name: e.target.value })} /></label>
          <label className="field"><span>Leads purchased</span><input type="number" min={0} value={batch.purchased_count} onChange={(e) => setBatch({ ...batch, purchased_count: e.target.value })} style={{ width: 110 }} /></label>
          <label className="field">
            <span>Total cost ($)</span>
            <input inputMode="decimal" value={batch.cost_total} onChange={(e) => setBatch({ ...batch, cost_total: e.target.value })} style={{ width: 120 }} placeholder={costFromTypes != null ? (costFromTypes / 100).toFixed(2) : ''} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}><span>Notes</span><input value={batch.notes} onChange={(e) => setBatch({ ...batch, notes: e.target.value })} /></label>
        </div>
        <p className="help">
          {costFromTypes != null
            ? `Leave the cost blank to use your prices: ${fmtMoney(costFromTypes)} for ${willImport.length} leads. Each lead keeps its own price, so mixed orders are costed right.`
            : 'Cost is optional. Set prices for your lead types in Settings to have it filled in.'}
        </p>
        <label className="row" style={{ gap: 6, marginTop: 8 }}>
          <input type="checkbox" checked={toList} onChange={(e) => setToList(e.target.checked)} />
          Add these leads to the call list
        </label>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={commit} disabled={busy || reading || toCheck.length > 0 || !batch.name.trim() || willImport.length === 0}>
            Import {willImport.length} lead{willImport.length === 1 ? '' : 's'}
          </button>
          {toCheck.length > 0 && <span className="warn">Check the {toCheck.length} lead{toCheck.length === 1 ? '' : 's'} that need a look first.</span>}
          {reading && <span className="help">Waiting for the pages to finish reading.</span>}
        </div>
        {problems.length > 0 && <ul className="error">{problems.map((x) => <li key={x}>{x}</li>)}</ul>}
      </div>

      {review && (
        <ReviewWindow
          draft={v}
          rowNumbers={review.rows}
          start={review.start}
          types={types}
          onChanged={load}
          onClose={() => setReview(null)}
          onLeave={() => {
            setReview(null);
            onLeave();
          }}
          onDelete={async () => {
            await api.del(`/drafts/${id}`).catch((e) => toast(e.message, 'error'));
            setReview(null);
            onGone();
          }}
        />
      )}
    </>
  );
}

function readerName(r: string | null | undefined) {
  if (!r) return 'the AI';
  const [, provider, model] = r.split(':');
  if (provider === 'claude_code') return `Claude (${model}, your account)`;
  if (provider === 'anthropic_api') return `Claude API (${model})`;
  if (provider === 'openai_compatible') return `${model} (local / OpenAI-compatible)`;
  return model ?? r;
}

function SummaryTiles({ s }: { s: DraftSummary }) {
  return (
    <div className="summary-tiles">
      <div><b>{s.total}</b>{s.total === 1 ? 'lead' : 'pages / rows'}</div>
      <div><b className="ok">{s.accepted}</b>will import</div>
      <div><b>{s.discarded}</b>discarded</div>
      <div><b className="error">{s.rejected - s.discarded}</b>missing info</div>
      <div><b>{s.duplicate_in_file}</b>repeated in file</div>
      <div><b>{s.already_imported}</b>already imported</div>
      <div><b className="warn">{s.possible_duplicates}</b>same phone as existing</div>
      {s.in_dead_pile > 0 && <div><b className="warn">{s.in_dead_pile}</b>in dead pile</div>}
    </div>
  );
}

function Done({ r, onAgain }: { r: { batch_id: string; summary: DraftSummary; call_list?: AddResult | null }; onAgain: () => void }) {
  const { go } = useApp();
  return (
    <div className="card">
      <h2>Import finished</h2>
      <SummaryTiles s={r.summary} />
      <ul className="plain">{r.summary.by_county.map((c) => <li key={c.county_key ?? 'x'}>{c.county}: <b>{c.count}</b></li>)}</ul>
      {r.call_list ? (
        <p><b>{r.call_list.added}</b> lead{r.call_list.added === 1 ? '' : 's'} added to your call list.</p>
      ) : (
        <p className="help">These leads aren't on your call list. "See the imported leads" shows just this batch on Leads, where you can add them.</p>
      )}
      <div className="row">
        {r.call_list && <button className="btn primary" onClick={() => go('calling')}>Start calling</button>}
        <button
          className={r.call_list ? 'btn' : 'btn primary'}
          onClick={() => {
            showImportedLeads({ batch: r.batch_id });
            go('leads');
          }}
        >
          See the imported leads
        </button>
        {r.summary.total - r.summary.accepted > 0 && <a className="btn" href={`/api/imports/${r.batch_id}/problems.csv`}>Download leads not imported (CSV)</a>}
        <button className="btn" onClick={() => go('settings')}>County area codes</button>
        <button className="btn" onClick={onAgain}>Import another file</button>
      </div>
    </div>
  );
}

function BatchList() {
  const { go } = useApp();
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    api.get<any[]>('/imports').then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows?.length) return null;
  return (
    <div className="card">
      <h2>Previous imports</h2>
      <table className="grid">
        <thead><tr><th>Batch</th><th>Imported</th><th>File</th><th>Leads</th><th>Not imported</th><th>Repeats</th><th>Cost</th><th></th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td>{b.name}</td><td>{fmtDateTime(b.imported_at)}</td><td className="muted">{b.file_name}</td>
              <td>{b.rows_accepted}</td><td>{b.rows_rejected}</td><td>{b.rows_repeat}</td>
              <td>{b.cost_total_cents != null ? fmtMoney(b.cost_total_cents) : <span className="muted">unknown</span>}</td>
              <td className="row" style={{ gap: 8 }}>
                {b.rows_accepted > 0 && (
                  <button className="btn small" onClick={() => { showImportedLeads({ batch: b.id }); go('leads'); }}>See leads</button>
                )}
                {b.rows_total > b.rows_accepted && <a href={`/api/imports/${b.id}/problems.csv`}>leads not imported</a>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function clean(m: Record<string, string>) {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v));
}
