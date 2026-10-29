import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDateTime, fmtMoney } from '../api';
import { useApp } from '../App';
import { useLeadTypes } from '../leadTypes';
import type { BatchFilter, BatchListRow as BatchRow, ImportGroup } from '../../shared/batches';

// Finding batches once there are hundreds: the filter bar used on Import, Leads and Reports, the batch
// picker on Leads, and the import history on Import. Each bulk import is one line, opened to see its files.

const DAYS = [
  [0, 'Any time'], [7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year'],
] as const;

/** The filter as query params for /imports/browse. */
export function filterParams(f: BatchFilter): Record<string, string | undefined> {
  return {
    search: f.search?.trim() || undefined,
    days: f.days ? String(f.days) : undefined,
    lead_type: f.lead_type === undefined ? undefined : f.lead_type || 'none',
    left: f.left ? '1' : undefined,
  };
}

export function isFiltered(f: BatchFilter) {
  return !!(f.search?.trim() || f.days || f.lead_type !== undefined || f.left);
}

/** Search, how recent, lead type and "still has leads to call". */
export function BatchFilterBar({ value, onChange, autoFocus }: { value: BatchFilter; onChange: (f: BatchFilter) => void; autoFocus?: boolean }) {
  const { types } = useLeadTypes();
  return (
    <div className="row batch-filters">
      <input
        type="search"
        placeholder="Search batch, file or lead type"
        aria-label="Search batches"
        value={value.search ?? ''}
        autoFocus={autoFocus}
        onChange={(e) => onChange({ ...value, search: e.target.value })}
      />
      <select aria-label="Imported" value={value.days ?? 0} onChange={(e) => onChange({ ...value, days: Number(e.target.value) || undefined })}>
        {DAYS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
      </select>
      <select
        aria-label="Batch lead type"
        value={value.lead_type === undefined ? '*' : value.lead_type || 'none'}
        onChange={(e) => onChange({ ...value, lead_type: e.target.value === '*' ? undefined : e.target.value === 'none' ? '' : e.target.value })}
      >
        <option value="*">Any lead type</option>
        {types.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
        <option value="none">No lead type</option>
      </select>
      <label className="row" style={{ gap: 4 }} title="Batches with leads never called, not answered yet, or waiting on a callback">
        <input type="checkbox" checked={!!value.left} onChange={(e) => onChange({ ...value, left: e.target.checked })} /> Leads left to call
      </label>
      {isFiltered(value) && <button className="btn small" type="button" onClick={() => onChange({})}>Clear</button>}
    </div>
  );
}

/** A page of import groups for this filter, with "show more". */
function useImportGroups(filter: BatchFilter, pageSize = 25) {
  const { toast } = useApp();
  const [groups, setGroups] = useState<ImportGroup[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(pageSize);
  const key = JSON.stringify(filterParams(filter));
  // A new filter starts from the first page.
  useEffect(() => setLimit(pageSize), [key, pageSize]);
  const load = useCallback(
    () =>
      api
        .get<{ groups: ImportGroup[]; total: number }>('/imports/browse', { ...filterParams(JSON.parse(key) as BatchFilter), limit: String(limit) })
        .then((r) => { setGroups(r.groups); setTotal(r.total); })
        .catch((e: Error) => toast(`Couldn't load imports: ${e.message}`, 'error')),
    [key, limit, toast],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);
  return { groups, total, more: () => setLimit((n) => n + pageSize), reload: load };
}

function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
      <button className="btn small" type="button" onClick={onMore}>Show more ({total - shown} older)</button>
    </div>
  );
}

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const bulkName = (g: ImportGroup) => `Bulk import · ${plural(g.bulk?.files ?? g.batches_total, 'file')}`;

/** The label for a picked batch ("" = all), or a bulk import ("bulk:<id>"). */
function useKeyLabel(value: string) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!value) return setLabel('');
    let live = true;
    api
      .get<{ groups: ImportGroup[] }>('/imports/browse', { key: value })
      .then((r) => {
        const g = r.groups[0];
        const b = g?.batches.find((x) => x.id === value);
        if (live) setLabel(b ? b.name : g ? `${bulkName(g)} · ${fmtDateTime(g.imported_at)}` : 'Unknown batch');
      })
      .catch(() => live && setLabel('Batch')); // The picker still works; only its label is missing.
    return () => { live = false; };
  }, [value]);
  return [label, setLabel] as const;
}

/**
 * Picks a batch, or every file of a bulk import ("bulk:<id>"), or all ("").
 * Type to search; bulk imports open to show their files.
 */
export function BatchPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<BatchFilter>({});
  const [label, setLabel] = useKeyLabel(value);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const pick = (v: string, l: string) => {
    setLabel(l);
    onChange(v);
    setOpen(false);
  };
  return (
    <div className="batch-picker" ref={box} onKeyDown={(e) => e.key === 'Escape' && open && (e.stopPropagation(), setOpen(false))}>
      <button type="button" className="btn" aria-label="Batch" aria-expanded={open} onClick={() => setOpen(!open)}>
        {value ? label || 'Batch…' : 'All batches'} ▾
      </button>
      {open && (
        <div className="batch-pop" role="dialog" aria-label="Pick a batch">
          <BatchFilterBar value={filter} onChange={setFilter} autoFocus />
          <PickerList filter={filter} value={value} onPick={pick} />
        </div>
      )}
    </div>
  );
}

function PickerList({ filter, value, onPick }: { filter: BatchFilter; value: string; onPick: (v: string, label: string) => void }) {
  const { groups, total, more } = useImportGroups(filter, 30);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const searching = isFiltered(filter);
  if (!groups) return <p className="muted">Loading…</p>;
  const item = (v: string, l: string, sub: string, indent = false) => (
    <button key={v} type="button" className={`pick-item${v === value ? ' on' : ''}${indent ? ' indent' : ''}`} onClick={() => onPick(v, l)}>
      <span>{l}</span><span className="muted small">{sub}</span>
    </button>
  );
  return (
    <div className="batch-pop-list">
      {item('', 'All batches', '')}
      {groups.length === 0 && <p className="muted">No batches match.</p>}
      {groups.map((g) => {
        if (g.kind === 'batch') {
          const b = g.batches[0]!;
          return item(b.id, b.name, `${fmtDateTime(b.imported_at)} · ${plural(b.rows_accepted, 'lead')}`);
        }
        if (!g.batches.length) return null;
        const show = searching || opened.has(g.id);
        const name = `${bulkName(g)} · ${fmtDateTime(g.imported_at)}`;
        return (
          <div key={g.id}>
            <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
              <button
                type="button"
                className="btn small"
                aria-label={show ? 'Hide files' : 'Show files'}
                onClick={() => setOpened((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })}
              >
                {show ? '▾' : '▸'}
              </button>
              {item(`bulk:${g.id}`, name, `${plural(g.totals.leads, 'lead')}, every file`)}
            </div>
            {show && g.batches.map((b) => item(b.id, b.name, `${plural(b.rows_accepted, 'lead')}`, true))}
            {show && g.batches.length < g.batches_total && <div className="muted small indent">{g.batches_total - g.batches.length} other files don't match</div>}
          </div>
        );
      })}
      <ShowMore shown={groups.length} total={total} onMore={more} />
    </div>
  );
}

/** Past imports on the Import page: bulk imports and single files together, newest first. */
export function ImportHistory({ onOpenBulk, onSeeLeads }: { onOpenBulk: (id: string) => void; onSeeLeads: (what: { batch: string } | { bulk: string }) => void }) {
  const [filter, setFilter] = useState<BatchFilter>({});
  const { groups, total, more } = useImportGroups(filter);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  if (!groups || (!groups.length && !isFiltered(filter))) return null;
  const toggle = (id: string) => setOpened((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const cost = (c: number | null) => (c != null ? fmtMoney(c) : <span className="muted">unknown</span>);
  const batchCells = (b: BatchRow) => (
    <>
      <td>{b.rows_accepted.toLocaleString()}</td><td>{b.left.toLocaleString()}</td><td>{b.rows_rejected}</td><td>{b.rows_repeat}</td>
      <td>{b.lead_types.filter(Boolean).join(', ')}</td><td>{cost(b.cost_cents)}</td>
    </>
  );
  return (
    <div className="card">
      <h2>Past imports <span className="muted small">({plural(total, isFiltered(filter) ? 'match' : 'import')})</span></h2>
      <BatchFilterBar value={filter} onChange={setFilter} />
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Import</th><th>Imported</th><th>Leads</th><th title="Never called, no answer yet, or a callback">Left to call</th><th>Not imported</th><th>Repeats</th><th>Type</th><th>Cost</th><th /></tr></thead>
          <tbody>
            {groups.map((g) => {
              if (g.kind === 'batch') {
                const b = g.batches[0]!;
                return (
                  <tr key={g.id}>
                    <td>{b.name}<div className="muted small">{b.file_name}</div></td><td>{fmtDateTime(b.imported_at)}</td>
                    {batchCells(b)}
                    <td className="row" style={{ gap: 8 }}>
                      {b.rows_accepted > 0 && <button className="btn small" onClick={() => onSeeLeads({ batch: b.id })}>See leads</button>}
                      {b.rows_total > b.rows_accepted && <a href={`/api/imports/${b.id}/problems.csv`}>leads not imported</a>}
                    </td>
                  </tr>
                );
              }
              const show = opened.has(g.id) || (isFiltered(filter) && g.batches.length > 0);
              const t = g.totals;
              return [
                <tr key={g.id} className="group-row">
                  <td>
                    {g.batches.length > 0 && (
                      <button className="btn small" aria-label={show ? 'Hide files' : 'Show files'} onClick={() => toggle(g.id)} style={{ marginRight: 6 }}>{show ? '▾' : '▸'}</button>
                    )}
                    {bulkName(g)}
                    {g.batches.length < g.batches_total && <span className="muted small"> ({g.batches.length} match)</span>}
                    {(g.bulk?.reading || g.bulk?.to_check) ? (
                      <div className="warn small">{[g.bulk.reading ? `${g.bulk.reading} reading` : '', g.bulk.to_check ? `${g.bulk.to_check} to check` : ''].filter(Boolean).join(', ')}</div>
                    ) : null}
                  </td>
                  <td>{fmtDateTime(g.imported_at)}</td>
                  <td>{t.leads.toLocaleString()}</td><td>{t.left.toLocaleString()}</td><td>{t.rejected}</td><td>{t.repeats}</td>
                  <td>{t.lead_types.filter(Boolean).join(', ')}</td><td>{cost(t.cost_cents)}</td>
                  <td className="row" style={{ gap: 8 }}>
                    {t.leads > 0 && <button className="btn small" onClick={() => onSeeLeads({ bulk: g.id })}>See leads</button>}
                    <button className="btn small" onClick={() => onOpenBulk(g.id)}>Open</button>
                  </td>
                </tr>,
                ...(show
                  ? g.batches.map((b) => (
                    <tr key={b.id} className="child-row">
                      <td className="indent">{b.name}</td><td>{fmtDateTime(b.imported_at)}</td>
                      {batchCells(b)}
                      <td className="row" style={{ gap: 8 }}>
                        {b.rows_accepted > 0 && <button className="btn small" onClick={() => onSeeLeads({ batch: b.id })}>See leads</button>}
                        {b.rows_total > b.rows_accepted && <a href={`/api/imports/${b.id}/problems.csv`}>not imported</a>}
                      </td>
                    </tr>
                  ))
                  : []),
              ];
            })}
          </tbody>
        </table>
      </div>
      {groups.length === 0 && <div className="empty">No imports match.</div>}
      <ShowMore shown={groups.length} total={total} onMore={more} />
    </div>
  );
}
