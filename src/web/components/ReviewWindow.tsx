import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { DraftRow, DraftView, LeadType } from '../importTypes';

// The review window: the lead page (or the original spreadsheet row) on the left, the fields on the right.
// OK adds the lead to the batch, Discard drops it, Cancel asks whether to keep the import for later.

const FIELDS: { key: string; label: string; required?: boolean; sheetOnly?: boolean }[] = [
  { key: 'full_name', label: 'Name', required: true },
  { key: 'first_name', label: 'First name', sheetOnly: true },
  { key: 'last_name', label: 'Last name', sheetOnly: true },
  { key: 'phone', label: 'Contact phone', required: true },
  { key: 'phone2', label: 'Alternate phone' },
  { key: 'phone3', label: 'Called in from' },
  { key: 'address', label: 'Street address', required: true },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'county', label: 'County it was bought for', required: true },
  { key: 'lender', label: 'Lender' },
  { key: 'loan_amount', label: 'Mortgage amount' },
  { key: 'age', label: 'Age' },
  { key: 'dob', label: 'Date of birth' },
  { key: 'coborrower', label: 'Co-borrower' },
  { key: 'source_lead_id', label: 'Lead ID' },
  { key: 'callin_date', label: 'Call-in date' },
  { key: 'status', label: 'Status (becomes call history)', sheetOnly: true },
];

export function ReviewWindow({
  draft, rowNumbers, start, types, onChanged, onClose, onLeave, onDelete,
}: {
  draft: DraftView;
  /** Rows to step through (usually the ones that need a look). */
  rowNumbers: number[];
  start: number;
  types: LeadType[];
  onChanged: () => Promise<DraftView | null>;
  onClose: () => void;
  /** "Keep it to finish later": back to the import screen, draft saved. */
  onLeave: () => void;
  onDelete: () => Promise<void>;
}) {
  const { toast } = useApp();
  const [list, setList] = useState(rowNumbers);
  const [idx, setIdx] = useState(Math.min(start, Math.max(0, rowNumbers.length - 1)));
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const rowNumber = list[idx];
  const row = draft.rows.find((r) => r.row_number === rowNumber) ?? null;

  const [values, setValues] = useState<Record<string, string>>({});
  const [leadType, setLeadType] = useState<string>('');
  const firstInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!row) return;
    setValues({ ...(row.fields as Record<string, string>) });
    setLeadType(row.lead_type ?? '');
    // Put the cursor in the first field that needs something.
    setTimeout(() => {
      const bad = document.querySelector<HTMLInputElement>('.review-form .has-issue input');
      (bad ?? firstInput.current)?.focus();
    }, 0);
  }, [row?.row_number, draft.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!row) return null;

  const edits = () => {
    const out: Record<string, string> = {};
    for (const f of FIELDS) {
      const now = (values[f.key] ?? '').trim();
      const read = ((row.fields as Record<string, string>)[f.key] ?? '').trim();
      if (now !== read) out[f.key] = now;
    }
    return out;
  };

  const act = async (action: 'ok' | 'discard') => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/drafts/${draft.id}/rows/${row.row_number}`, {
        action,
        edits: edits(),
        lead_type: leadType || null,
      });
      const v = await onChanged();
      // Move on to the next lead that still needs a look.
      const remaining = list.filter((n) => n !== row.row_number && v?.rows.find((r) => r.row_number === n)?.review === 'needs_review');
      if (!remaining.length) {
        toast(action === 'ok' ? 'Added. Every lead has been checked.' : 'Discarded. Every lead has been checked.');
        onClose();
        return;
      }
      const after = remaining.find((n) => n > row.row_number) ?? remaining[0]!;
      setList(remaining);
      setIdx(remaining.indexOf(after));
      toast(action === 'ok' ? 'Added to the batch' : 'Discarded');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const issuesFor = (key: string) =>
    row.issues.filter((i) => i.field === key || (key === 'full_name' && ['first_name', 'last_name'].includes(i.field)));
  const pageIssues = row.issues.filter((i) => !i.field || !FIELDS.some((f) => f.key === i.field));
  const isSheet = draft.kind === 'sheet';
  const shown = FIELDS.filter((f) => {
    if (f.sheetOnly) return isSheet && (f.key in row.fields || f.key in row.read);
    if (f.key === 'full_name' && isSheet && !('full_name' in row.read) && ('first_name' in row.read || 'last_name' in row.read)) return false;
    return true;
  });

  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setConfirmCancel(true))}>
      <div className="modal review" role="dialog" aria-label="Check this lead">
        <header>
          <b>
            Check this lead · {isSheet ? `row ${row.row_number}` : `page ${row.page}`}
            {list.length > 1 && <span className="muted"> · {idx + 1} of {list.length}</span>}
          </b>
          <div className="row">
            <button className="btn small" disabled={idx === 0} onClick={() => setIdx(idx - 1)} title="Previous lead to check">‹ Previous</button>
            <button className="btn small" disabled={idx >= list.length - 1} onClick={() => setIdx(idx + 1)} title="Leave this one for now">Next ›</button>
          </div>
        </header>
        <div className="review-body">
          <div className="review-source">
            {isSheet ? <SheetCells raw={row.raw ?? {}} /> : <PageImage draftId={draft.id} page={row.page!} />}
          </div>
          <form
            className="review-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act('ok');
            }}
          >
            {pageIssues.length > 0 && (
              <ul className="issues">
                {pageIssues.map((i, n) => <li key={n} className={i.blocking ? 'error' : 'warn'}>{i.message}</li>)}
              </ul>
            )}
            {row.notes && <p className="help">{row.extractor?.startsWith('ai:') ? 'AI notes: ' : ''}{row.notes}</p>}
            {shown.map((f, n) => {
              const iss = issuesFor(f.key);
              return (
                <label key={f.key} className={`field ${iss.some((i) => i.blocking) ? 'has-issue' : ''}`}>
                  <span>{f.label}{f.required && ' *'}</span>
                  <input
                    ref={n === 0 ? firstInput : undefined}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    placeholder={f.key === 'county' && !values.county && row.county ? `${row.county} (worked out from the address)` : undefined}
                    autoComplete="off"
                  />
                  {iss.map((i, k) => <small key={k} className={i.blocking ? 'error' : 'warn'}>{i.message}</small>)}
                </label>
              );
            })}
            <label className="field">
              <span>Lead type</span>
              <select value={leadType} onChange={(e) => setLeadType(e.target.value)}>
                <option value="">Same as the batch ({draft.settings.default_lead_type ?? 'none'})</option>
                {types.filter((t) => t.active).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
              </select>
            </label>
            <div className="row review-actions">
              <button type="submit" className="btn primary" disabled={busy}>OK, add it <kbd>Enter</kbd></button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => act('discard')}>Discard</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel <kbd>Esc</kbd></button>
            </div>
          </form>
        </div>
      </div>
      {confirmCancel && (
        <div className="modal-back" style={{ zIndex: 60 }}>
          <div className="modal" style={{ width: 'min(460px, 100%)' }} role="alertdialog" aria-label="Cancel this import?">
            <header><b>Are you sure you want to cancel this import?</b></header>
            <div className="body">
              <p>Nothing has been added to your leads yet. You can keep what you've checked so far and finish later, or delete the import.</p>
              <div className="row">
                <button className="btn primary" autoFocus onClick={onLeave}>Keep it to finish later</button>
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!window.confirm('Delete this import and everything checked so far?')) return;
                    await onDelete();
                  }}
                >
                  Delete this import
                </button>
                <button className="btn" onClick={() => setConfirmCancel(false)}>Go back to the lead</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PageImage({ draftId, page }: { draftId: string; page: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [rotate, setRotate] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const url = `/api/drafts/${draftId}/file`;
  useLayoutEffect(() => {
    if (!canvas.current || !box.current) return;
    setErr(null);
    const width = Math.max(300, box.current.clientWidth - 4);
    const el = canvas.current;
    // The PDF viewer is loaded only when a page is shown.
    import('../pdfView')
      .then((m) => m.renderPage(el, url, page, width, rotate, zoom))
      .catch((e) => setErr(String(e?.message ?? e)));
  }, [url, page, rotate, zoom]);
  useEffect(() => {
    setRotate(0);
    setZoom(1);
  }, [page]);
  return (
    <div ref={box} className="page-image">
      <div className="row page-tools">
        <button type="button" className="btn small" onClick={() => setRotate((r) => (r + 90) % 360)} title="Turn the page">⟳ Turn</button>
        <button type="button" className="btn small" onClick={() => setZoom((z) => Math.min(4, z * 1.5))}>Zoom in</button>
        <button type="button" className="btn small" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} disabled={zoom === 1}>Zoom out</button>
        <a className="btn small" href={`${url}#page=${page}`} target="_blank" rel="noreferrer">Open the PDF</a>
      </div>
      {err && <p className="error">Couldn't show this page ({err}). Use "Open the PDF".</p>}
      <div className="page-scroll"><canvas ref={canvas} aria-label={`Page ${page}`} /></div>
    </div>
  );
}

function SheetCells({ raw }: { raw: Record<string, string> }) {
  const entries = Object.entries(raw);
  return (
    <div className="page-scroll">
      <p className="help">The row as it is in your spreadsheet:</p>
      <table className="grid">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}><th style={{ position: 'static' }}>{k}</th><td>{String(v ?? '') || <span className="muted">(blank)</span>}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type { DraftRow };
