import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, fmtMoney, fmtPhone, type AddResult } from '../api';
import { useApp } from '../App';
import { ReviewWindow } from '../components/ReviewWindow';
import type { DraftView, DraftRow, DraftSummary } from '../importTypes';
import { showImportedLeads } from './LeadsPage';
import { useLeadTypes } from '../leadTypes';
// The draft of one import: progress while a PDF is read, the rows to check, lead types, and the import itself.
// Then what was imported (Done).

const RESULT_TEXT: Record<string, string> = {
  accepted: 'Will import', rejected: 'Not importing', duplicate_in_file: 'Repeat in this file', already_imported: 'Already imported',
};
const REVIEW_TEXT: Record<DraftRow['review'], string> = { auto: 'Read fine', needs_review: 'Needs a look', ok: 'Checked', discarded: 'Discarded' };

export function DraftScreen({ id, onLeave, onGone, onCommitted }: {
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

export function Done({ r, onAgain }: { r: { batch_id: string; summary: DraftSummary; call_list?: AddResult | null }; onAgain: () => void }) {
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
