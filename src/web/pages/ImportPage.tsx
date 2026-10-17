import { useEffect, useState } from 'react';
import { api, ApiError, fmtDateTime, fmtMoney, fmtPhone } from '../api';
import { useApp } from '../App';

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
interface PreviewRow {
  row_number: number;
  status: string;
  errors: string[];
  warnings: string[];
  name: string;
  phone: string | null;
  state: string | null;
  lender: string | null;
  loan_amount_cents: number | null;
  age: number | null;
}
interface Preview {
  summary: {
    total: number; accepted: number; rejected: number; duplicate_in_file: number; already_imported: number;
    with_warnings: number; possible_duplicates: number; in_dead_pile: number;
    file_previously_imported: { batch_id: string; name: string; imported_at: string }[];
  };
  rows: PreviewRow[];
}

const STATUS_TEXT: Record<string, string> = {
  accepted: 'Will import', rejected: 'Rejected', duplicate_in_file: 'Repeat in this file', already_imported: 'Already imported',
};

export function ImportPage() {
  const { meta, toast, go } = useApp();
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [filter, setFilter] = useState<'problems' | 'all'>('problems');
  const [repeatsAsNew, setRepeatsAsNew] = useState(false);
  const [batch, setBatch] = useState({ name: '', purchased_count: '', cost_total: '', cost_per_lead: '', lead_type: '', lead_age_label: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<{ batch_id: string; summary: Preview['summary'] } | null>(null);

  const sheet = parsed?.sheets.find((s) => s.name === sheetName) ?? null;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setPreview(null);
    setDone(null);
    setProblems([]);
    try {
      const r = await api.upload<ParseResult>('/imports/parse', f);
      setParsed(r);
      const s = r.sheets[0]!;
      setSheetName(s.name);
      setMapping(s.suggested_mapping);
      setBatch((b) => ({ ...b, name: f.name.replace(/\.(xlsx|xlsm|csv|tsv|txt)$/i, '') }));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    if (!parsed) return;
    setBusy(true);
    setProblems([]);
    try {
      setPreview(await api.post<Preview>('/imports/preview', { upload_id: parsed.upload_id, sheet: sheetName, mapping: clean(mapping), import_repeats_as_new: repeatsAsNew }));
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!parsed || !preview) return;
    setBusy(true);
    try {
      const cents = (v: string) => (v.trim() ? Math.round(Number(v.replace(/[$,]/g, '')) * 100) : null);
      const r = await api.post<{ batch_id: string; summary: Preview['summary'] }>('/imports/commit', {
        upload_id: parsed.upload_id,
        sheet: sheetName,
        mapping: clean(mapping),
        import_repeats_as_new: repeatsAsNew,
        batch: {
          name: batch.name,
          purchased_count: batch.purchased_count ? Number(batch.purchased_count) : null,
          cost_total_cents: cents(batch.cost_total),
          cost_per_lead_cents: cents(batch.cost_per_lead),
          lead_type: batch.lead_type || null,
          lead_age_label: batch.lead_age_label || null,
          notes: batch.notes || null,
        },
      });
      setDone(r);
      setParsed(null);
      setPreview(null);
      toast(`Imported ${r.summary.accepted} leads`);
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(false);
    }
  };

  const handleErr = (e: unknown) => {
    if (e instanceof ApiError) {
      setProblems(e.problems.length ? e.problems : [e.message]);
    } else toast(String(e), 'error');
  };

  if (done) {
    return (
      <div className="card">
        <h2>Import finished</h2>
        <Tiles s={done.summary} />
        <div className="row">
          <button className="btn primary" onClick={() => go('calling')}>Start calling</button>
          {done.summary.total - done.summary.accepted > 0 && (
            <a className="btn" href={`/api/imports/${done.batch_id}/problems.csv`}>Download rows not imported (CSV)</a>
          )}
          <button className="btn" onClick={() => setDone(null)}>Import another file</button>
        </div>
        <BatchList />
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>1. Choose a file</h2>
        <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" onChange={(e) => onFile(e.target.files?.[0])} disabled={busy} />
        <p className="help">Excel (.xlsx) or CSV. The first row with two or more filled cells is treated as the header row. Nothing is saved until you press Import.</p>
        {parsed && parsed.file_previously_imported.length > 0 && (
          <p className="warn">
            This exact file was imported before ({parsed.file_previously_imported.map((b) => `${b.name}, ${fmtDateTime(b.imported_at)}`).join('; ')}). Rows already imported will be skipped.
          </p>
        )}
      </div>

      {parsed && sheet && (
        <div className="card">
          <h2>2. Match the columns</h2>
          <div className="row">
            {parsed.sheets.length > 1 && (
              <label className="field">
                <span>Sheet</span>
                <select value={sheetName} onChange={(e) => {
                  const s = parsed.sheets.find((x) => x.name === e.target.value)!;
                  setSheetName(s.name);
                  setMapping(s.suggested_mapping);
                  setPreview(null);
                }}>
                  {parsed.sheets.map((s) => <option key={s.name}>{s.name}</option>)}
                </select>
              </label>
            )}
            <span className="muted">
              {sheet.row_count} rows, headers on row {sheet.header_row}. {sheet.mapping_source === 'saved' ? 'Using the mapping you saved for this layout.' : 'Matches were guessed from the headers; check them.'}
            </span>
          </div>
          <table className="grid" style={{ marginTop: 8 }}>
            <thead><tr><th>Field</th><th>Column in your file</th><th>Sample values</th></tr></thead>
            <tbody>
              {meta?.lead_fields.map((f) => {
                const col = mapping[f.key] ?? '';
                return (
                  <tr key={f.key}>
                    <td>{f.label}{['phone'].includes(f.key) && ' *'}</td>
                    <td>
                      <select value={col} onChange={(e) => { setMapping({ ...mapping, [f.key]: e.target.value }); setPreview(null); }} aria-label={`Column for ${f.label}`}>
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
          <p className="help">* Required, plus a full name or first/last name. Columns you don't match are still saved with each lead.</p>
          <label className="row" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={repeatsAsNew} onChange={(e) => { setRepeatsAsNew(e.target.checked); setPreview(null); }} />
            Import leads identical to ones already imported as new leads (for example, you bought the same lead again)
          </label>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={runPreview} disabled={busy}>Preview</button>
          </div>
          {problems.length > 0 && <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
      )}

      {preview && (
        <div className="card">
          <h2>3. Check the preview</h2>
          <Tiles s={preview.summary} />
          <div className="tabs" style={{ margin: '8px 0' }}>
            <button className={filter === 'problems' ? 'active' : ''} onClick={() => setFilter('problems')}>Rows with problems or notes</button>
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All rows</button>
          </div>
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            <table className="grid">
              <thead><tr><th>Row</th><th>Result</th><th>Name</th><th>Phone</th><th>State</th><th>Lender</th><th>Loan</th><th>Age</th><th>Problems / notes</th></tr></thead>
              <tbody>
                {preview.rows.filter((r) => filter === 'all' || r.errors.length || r.warnings.length || r.status !== 'accepted').map((r) => (
                  <tr key={r.row_number}>
                    <td>{r.row_number}</td>
                    <td className={r.status === 'accepted' ? 'ok' : r.status === 'rejected' ? 'error' : 'warn'}>{STATUS_TEXT[r.status] ?? r.status}</td>
                    <td>{r.name}</td>
                    <td>{r.phone?.startsWith('+1') ? fmtPhone(r.phone) : r.phone}</td>
                    <td>{r.state}</td>
                    <td>{r.lender}</td>
                    <td>{fmtMoney(r.loan_amount_cents)}</td>
                    <td>{r.age}</td>
                    <td><span className="error">{r.errors.join('; ')}</span>{r.errors.length && r.warnings.length ? '; ' : ''}<span className="warn">{r.warnings.join('; ')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 style={{ marginTop: 16 }}>4. Batch details</h2>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field"><span>Batch name *</span><input value={batch.name} onChange={(e) => setBatch({ ...batch, name: e.target.value })} /></label>
            <label className="field"><span>Leads purchased</span><input type="number" min={0} value={batch.purchased_count} onChange={(e) => setBatch({ ...batch, purchased_count: e.target.value })} style={{ width: 110 }} /></label>
            <label className="field"><span>Total cost ($)</span><input inputMode="decimal" value={batch.cost_total} onChange={(e) => setBatch({ ...batch, cost_total: e.target.value })} style={{ width: 110 }} /></label>
            <label className="field"><span>or cost per lead ($)</span><input inputMode="decimal" value={batch.cost_per_lead} onChange={(e) => setBatch({ ...batch, cost_per_lead: e.target.value })} style={{ width: 110 }} /></label>
            <label className="field"><span>Lead type</span><input value={batch.lead_type} onChange={(e) => setBatch({ ...batch, lead_type: e.target.value })} placeholder="e.g. mortgage protection" /></label>
            <label className="field"><span>Lead age</span><input value={batch.lead_age_label} onChange={(e) => setBatch({ ...batch, lead_age_label: e.target.value })} placeholder="e.g. 30-60 days" /></label>
          </div>
          <label className="field" style={{ marginTop: 8 }}><span>Notes</span><input value={batch.notes} onChange={(e) => setBatch({ ...batch, notes: e.target.value })} /></label>
          <p className="help">Cost is optional. Leave it blank if you don't know it; reports will say "cost unknown".</p>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={commit} disabled={busy || !batch.name.trim() || preview.summary.accepted === 0}>
              Import {preview.summary.accepted} lead{preview.summary.accepted === 1 ? '' : 's'}
            </button>
            <span className="help">Rejected and repeated rows are kept in the import record, not as leads.</span>
          </div>
          {problems.length > 0 && <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
      )}
      {!parsed && <BatchList />}
    </>
  );
}

function Tiles({ s }: { s: Preview['summary'] }) {
  return (
    <div className="summary-tiles">
      <div><b>{s.total}</b>rows</div>
      <div><b className="ok">{s.accepted}</b>will import</div>
      <div><b className="error">{s.rejected}</b>rejected</div>
      <div><b>{s.already_imported}</b>already imported</div>
      <div><b>{s.duplicate_in_file}</b>repeated in file</div>
      <div><b className="warn">{s.possible_duplicates}</b>same phone as existing</div>
      <div><b className="warn">{s.in_dead_pile}</b>in dead pile</div>
    </div>
  );
}

function BatchList() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    api.get<any[]>('/imports').then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows?.length) return null;
  return (
    <div className="card">
      <h2>Previous imports</h2>
      <table className="grid">
        <thead><tr><th>Batch</th><th>Imported</th><th>File</th><th>Leads</th><th>Rejected</th><th>Repeats</th><th>Cost/lead</th><th></th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td>{b.name}</td><td>{fmtDateTime(b.imported_at)}</td><td className="muted">{b.file_name}</td>
              <td>{b.rows_accepted}</td><td>{b.rows_rejected}</td><td>{b.rows_repeat}</td>
              <td>{b.cost_per_lead_cents != null ? fmtMoney(b.cost_per_lead_cents) : <span className="muted">unknown</span>}</td>
              <td>{b.rows_total > b.rows_accepted && <a href={`/api/imports/${b.id}/problems.csv`}>problem rows</a>}</td>
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
