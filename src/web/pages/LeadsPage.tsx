import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime, fmtLeadAge, fmtMoney, fmtPhone, fullName, type AddResult, type CallListResponse } from '../api';
import { CALL_LIST_CHANGED, ClearListDialog, suggestListName } from '../components/CallListDialogs';
import { useApp } from '../App';
import { LeadViewer } from '../components/LeadViewer';
import { GroupPicker, useGroups } from '../components/GroupPicker';
import { getStored, setStored } from '../storage';
import { useLeadTypes } from '../leadTypes';
import { AGE_BANDS } from '../../shared/leadAge';
import { BatchPicker } from '../components/BatchBrowse';
import type { LeadType } from '../importTypes';
import { APPT_DAYS, DIAL_GAPS, IMPORTED_WHEN, LAST_CALL, LEAD_PAGE_SIZES, gapLabel } from '../../shared/leadFilter';
import { UnmarkedAppointments } from '../components/UnmarkedAppointments';
import { NewRuleFromFilters } from './RulesCard';
import { useTags } from '../tags';
import { useCustomFields } from '../customFields';
import { CustomFieldInput } from '../components/CustomFieldInput';
import { ConditionEditor } from '../components/ConditionEditor';
import { StatusChips } from './StatusesCard';
import { useStatuses } from '../statuses';
import { isNumericField, normalizeCustomValue, showCustomValue } from '../../shared/customFields';

// Where you pick who to call: filter the leads, tick the ones you want (or take every match),
// and add them to the bottom of the call list on the Calling page, or put them in place of it.

const SHOW_KEY = 'mpcrm.leads.show';

/**
 * Opens the Leads page showing one import: a batch (one file) or a bulk import (all its files).
 * Call it, then go('leads').
 */
export function showImportedLeads(what: { batch: string } | { bulk: string }) {
  setStored(SHOW_KEY, 'batch' in what ? what.batch : `bulk:${what.bulk}`);
}

/** The import the Leads page was asked to show, used once. */
function takeShown(): string {
  const v = getStored(SHOW_KEY) ?? '';
  setStored(SHOW_KEY, null);
  return v;
}

export function LeadsPage() {
  const { meta, toast, go, reportAdded } = useApp();
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  /** A batch id, or "bulk:<id>" for every file of a bulk import. */
  const [batch, setBatch] = useState(takeShown);
  const [tried, setTried] = useState('');
  const [notOnList, setNotOnList] = useState(false);
  /** A lead type code, "none" for leads with no type, or '' for any. */
  const [leadType, setLeadType] = useState('');
  /** A lead age band, "unknown" for leads with no call-in date, or '' for any. */
  const [age, setAge] = useState('');
  /** Imported today, yesterday or this week (shared/leadFilter.ts), or '' for any time. */
  const [imported, setImported] = useState('');
  /** Appointment yesterday or since your last calling day, or '' for any. */
  const [apptDays, setApptDays] = useState('');
  /** Leave out leads dialed in the last this many minutes; 0 for no limit. */
  const [gap, setGap] = useState(0);
  /** A tag id, "none" for leads with no tags, or '' for any. */
  const [tag, setTag] = useState('');
  const { types } = useLeadTypes();
  const { tags, reload: reloadTags } = useTags();
  const [tagging, setTagging] = useState(false);
  /** A custom field to filter on ('' for none), and the value it must have ('' for any value). */
  const [fieldId, setFieldId] = useState('');
  const [fieldValue, setFieldValue] = useState('');
  /** For a number field: the range (either end may be blank). */
  const [fieldMin, setFieldMin] = useState('');
  const [fieldMax, setFieldMax] = useState('');
  /** A number field to put the highest first ('' for the usual order: latest activity first). */
  const [sortField, setSortField] = useState('');
  /** A condition in Python syntax ('' for none), and whether its editor is open. */
  const [where, setWhere] = useState('');
  /** One of your statuses shown as a tab (its id), or '' for the usual tabs. */
  const [inStatus, setInStatus] = useState('');
  const { statuses } = useStatuses();
  const [editingWhere, setEditingWhere] = useState(false);
  const { fields } = useCustomFields();
  const field = fields.find((f) => f.id === fieldId);
  const numeric = !!field && isNumericField(field);
  const sortBy = fields.find((f) => f.id === sortField);
  const keptValue = useMemo(() => {
    if (!field || numeric || !fieldValue.trim()) return undefined;
    try {
      return normalizeCustomValue(field, fieldValue) ?? undefined;
    } catch {
      // Not a value this field can hold (e.g. letters in a number): compare what was typed, which matches no one.
      return fieldValue.trim();
    }
  }, [field, numeric, fieldValue]);
  const num = (v: string) => (v.trim() && Number.isFinite(Number(v.replace(/[$,\s]/g, ''))) ? String(Number(v.replace(/[$,\s]/g, ''))) : undefined);
  const [changingType, setChangingType] = useState(false);
  const [makingRule, setMakingRule] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  // The filters the rows on screen were loaded for: until the new ones arrive, nothing can be ticked.
  const [rowsFor, setRowsFor] = useState<object | null>(null);
  const [total, setTotal] = useState(0);
  /** Which page of the list (from 1), and how many on a page (remembered). */
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(() => {
    const n = Number(getStored('leads_per_page'));
    return (LEAD_PAGE_SIZES as readonly number[]).includes(n) ? n : 100;
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [groups, setGroups, groupParams] = useGroups();
  const [callList, setCallList] = useState<CallListResponse | null>(null);
  const [replace, setReplace] = useState(false);
  /** Waiting on "keep the old list?" before replacing it with these leads. */
  const [replacing, setReplacing] = useState<'picked' | 'all' | null>(null);
  const loadCallList = useCallback(() => api.get<CallListResponse>('/call-list').then(setCallList).catch(() => setCallList(null)), []);
  useEffect(() => void loadCallList(), [loadCallList]);
  useEffect(() => {
    const on = () => void loadCallList();
    window.addEventListener(CALL_LIST_CHANGED, on);
    return () => window.removeEventListener(CALL_LIST_CHANGED, on);
  }, [loadCallList]);
  const onList = callList?.items.length ?? 0;
  const replaceNow = replace && onList > 0;
  const outcomeLabel = (c: string | null) => (c ? meta?.outcome_codes.find((o) => o.code === c)?.label ?? c : '');


  const filters = useMemo(() => ({
    status,
    search,
    batch_id: batch && !batch.startsWith('bulk:') ? batch : undefined,
    bulk_id: batch.startsWith('bulk:') ? batch.slice(5) : undefined,
    last_call: tried || undefined,
    not_on_list: notOnList ? '1' : undefined,
    lead_type: leadType || undefined,
    age: age || undefined,
    imported: imported || undefined,
    appt_days: apptDays || undefined,
    not_within_min: gap ? String(gap) : undefined,
    tag: tag || undefined,
    field_id: fieldId || undefined,
    field_value: fieldId ? keptValue : undefined,
    field_min: numeric ? num(fieldMin) : undefined,
    field_max: numeric ? num(fieldMax) : undefined,
    sort_field: sortField || undefined,
    where: where || undefined,
    in_status: inStatus || undefined,
    ...groupParams,
  }), [status, search, batch, tried, notOnList, leadType, age, imported, apptDays, gap, tag, fieldId, keptValue, numeric, fieldMin, fieldMax, sortField, where, inStatus, groupParams.counties, groupParams.area_codes]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(
    () => api.get<{ rows: any[]; total: number; page: number }>('/leads', { ...filters, page: String(page), per_page: String(perPage) })
      .then((r) => { setRows(r.rows); setRowsFor(filters); setTotal(r.total); if (r.page !== page) setPage(r.page); }, (e: Error) => toast(e.message, 'error')),
    [filters, page, perPage, toast],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);
  // A new filter starts a new choice.
  useEffect(() => {
    setPicked(new Set());
    setPage(1);
  }, [filters]);
  const pager = (
    <Pager
      page={page}
      perPage={perPage}
      total={total}
      onPage={setPage}
      onPerPage={(n) => { setPerPage(n); setPage(1); setStored('leads_per_page', String(n)); }}
    />
  );

  const fresh = rowsFor === filters;
  const pickable = fresh ? rows.filter((r) => r.callable && (!r.on_list || replaceNow)) : [];
  const allPicked = pickable.length > 0 && pickable.every((r) => picked.has(r.id));
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const filtered = status !== 'all' || !!search || !!batch || !!tried || notOnList || !!leadType || !!age || !!imported || !!apptDays || !!gap || !!tag || !!fieldId || !!sortField || !!where || !!inStatus;
  const clearFilters = () => {
    setStatus('all');
    setSearch('');
    setBatch('');
    setTried('');
    setNotOnList(false);
    setLeadType('');
    setAge('');
    setImported('');
    setApptDays('');
    setGap(0);
    setTag('');
    setFieldId('');
    setFieldValue('');
    setFieldMin('');
    setFieldMax('');
    setSortField('');
    setWhere('');
    setEditingWhere(false);
    setInStatus('');
  };
  const typeLabel = (code: string | null) => (code ? types.find((t) => t.code === code)?.label ?? code : '');

  const report = (r: AddResult, replaced = false) =>
    reportAdded(r, replaced ? `Call list replaced: ${r.added} lead${r.added === 1 ? '' : 's'} on it` : undefined);

  const addPicked = async (swap?: { save_current_as: string | null }) => {
    // In the order shown on screen.
    const ids = rows.filter((r) => picked.has(r.id)).map((r) => r.id);
    try {
      report(await api.post<AddResult>('/call-list', { lead_ids: ids, ...(swap ? { replace: true, ...swap } : {}) }), !!swap);
      setPicked(new Set());
      setReplacing(null);
      await Promise.all([load(), loadCallList()]);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const addAll = async (swap?: { save_current_as: string | null }) => {
    if (!swap && total > 50 && !window.confirm(`Add all ${total} matching leads to the call list?`)) return;
    try {
      report(await api.post<AddResult>('/call-list/add-matching', { ...filters, ...(swap ? { replace: true, ...swap } : {}) }), !!swap);
      setPicked(new Set());
      setReplacing(null);
      await Promise.all([load(), loadCallList()]);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <div className="leads-tools">
        <div className="tabs">
          {/* All, then your smart lists ticked as Leads tabs (Automation → Smart lists). */}
          <button className={!inStatus && status === 'all' ? 'active' : ''} onClick={() => { setStatus('all'); setInStatus(''); }}>All</button>
          {statuses.filter((st) => st.tab).map((st) => (
            <button key={st.id} className={inStatus === st.id ? 'active' : ''} title={`Your smart list: ${st.condition}`} onClick={() => { setStatus('all'); setInStatus(st.id); }}>{st.name}</button>
          ))}
        </div>
      </div>
      <div className="leads-tools">
        <input placeholder="Search name, county, phone, or area code" value={search} onChange={(e) => setSearch(e.target.value)} title="A 3-digit number finds every county under that area code" />
        <GroupPicker groups={groups} onChange={setGroups} />
        <BatchPicker value={batch} onChange={setBatch} />
        <select value={leadType} onChange={(e) => setLeadType(e.target.value)} aria-label="Lead type">
          <option value="">All lead types</option>
          {types.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
          <option value="none">No lead type</option>
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">Any tags</option>
          {tags.map((t) => <option key={t.id} value={t.id}>Tagged {t.name}</option>)}
          <option value="none">No tags</option>
        </select>
        {fields.length > 0 && (
          <span className="row" style={{ gap: 4 }}>
            <select value={fieldId} onChange={(e) => { setFieldId(e.target.value); setFieldValue(''); setFieldMin(''); setFieldMax(''); }} aria-label="Your field" title="Only leads with this field filled in, or with the value you pick">
              <option value="">Any of your fields</option>
              {fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            {field && numeric && (
              <>
                <input value={fieldMin} onChange={(e) => setFieldMin(e.target.value)} inputMode="decimal" placeholder="at least" aria-label={`${field.label} at least`} style={{ width: 80 }} />
                <input value={fieldMax} onChange={(e) => setFieldMax(e.target.value)} inputMode="decimal" placeholder="at most" aria-label={`${field.label} at most`} style={{ width: 80 }} />
              </>
            )}
            {field && !numeric && (
              <CustomFieldInput
                field={field.type === 'formula' ? { ...field, type: field.result === 'yes_no' ? 'yes_no' : 'text' } : field}
                value={fieldValue}
                onChange={setFieldValue}
                ariaLabel={`${field.label} is`}
                blank="any value"
              />
            )}
          </span>
        )}
        {fields.some(isNumericField) && (
          <select value={sortField} onChange={(e) => setSortField(e.target.value)} aria-label="Order" title="Put the leads with the highest value first, e.g. your lead score. Adding them to the call list keeps this order.">
            <option value="">Latest activity first</option>
            {fields.filter(isNumericField).map((f) => <option key={f.id} value={f.id}>Highest {f.label} first</option>)}
          </select>
        )}
        <select value={age} onChange={(e) => setAge(e.target.value)} aria-label="Lead age" title="Days since the lead called in (the call-in date on the lead page)">
          <option value="">Any lead age</option>
          {AGE_BANDS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          <option value="unknown">No call-in date</option>
        </select>
        <select value={imported} onChange={(e) => setImported(e.target.value)} aria-label="Imported" title="When the lead's file was imported, counting every file imported those days">
          <option value="">Imported any time</option>
          {IMPORTED_WHEN.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select value={apptDays} onChange={(e) => setApptDays(e.target.value)} aria-label="Appointment day" title={APPT_DAYS.find((d) => d.key === apptDays)?.title ?? 'Leads with an appointment on these days (from Unitrust, or logged here)'}>
          <option value="">Appointment any day</option>
          {APPT_DAYS.map((t) => <option key={t.key} value={t.key} title={t.title}>{t.label}</option>)}
        </select>
        <select value={tried} onChange={(e) => setTried(e.target.value)} aria-label="Last call">
          <option value="">Last call: any time</option>
          {LAST_CALL.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select value={gap} onChange={(e) => setGap(Number(e.target.value))} aria-label="Not dialed recently" title="Leave out leads you dialed in the last few minutes, so you don't ring them straight back">
          <option value={0}>Dialed any time</option>
          {DIAL_GAPS.map((m) => <option key={m} value={m}>Not dialed in the last {gapLabel(m)}</option>)}
        </select>
        <label className="row" style={{ gap: 4 }} title="Leaves out leads still waiting to be called on the list. Ones you already called from it can go back on.">
          <input type="checkbox" checked={notOnList} onChange={(e) => setNotOnList(e.target.checked)} /> Not on the call list
        </label>
        <button className="btn small" onClick={() => setEditingWhere(true)} title="Only leads a condition is true for, built from tags, their history, calls and fields. Edit it as a form or as Python.">
          {where ? 'Edit condition' : 'Condition…'}
        </button>
        {filtered && <button className="btn small" onClick={clearFilters}>Clear filters</button>}
      </div>
      {where && !editingWhere && (
        <div className="leads-tools">
          <span className="muted">Where</span> <code aria-label="Condition in use">{where}</code>
          <button className="btn small" onClick={() => setWhere('')} aria-label="Remove the condition">×</button>
        </div>
      )}
      {editingWhere && (
        <ConditionEditor value={where} onApply={(w) => { setWhere(w); setEditingWhere(false); }} onCancel={() => setEditingWhere(false)} />
      )}
      <div className="leads-tools">
        <span className="muted">{total} lead{total === 1 ? '' : 's'}</span>
        {pager}
        <div className="add-bar">
          {onList > 0 && (
            <label className="row" style={{ gap: 4 }} title="Empty the call list first, so only these leads are on it. You can keep the old list to call later.">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the call list ({onList} on it now)
            </label>
          )}
          <button className="btn primary" disabled={!picked.size} onClick={() => (replaceNow ? setReplacing('picked') : void addPicked())}>
            {replaceNow ? `Replace with ${picked.size || ''} ticked` : `Add ${picked.size || ''} ticked to call list`}
          </button>
          <button
            className="btn"
            disabled={!total}
            onClick={() => (replaceNow ? setReplacing('all') : void addAll())}
            title="Every lead matching these filters, not just the ones shown. Booked, bad-number and dead leads are left out."
          >
            {replaceNow ? `Replace with all ${total} matching` : `Add all ${total} matching`}
          </button>
          <button className="btn" disabled={!total} onClick={() => setChangingType(true)} title="Fix the lead type on every lead matching these filters, e.g. one batch">
            Change lead type
          </button>
          <button className="btn" disabled={!total} onClick={() => setTagging(true)} title="Put a tag on (or take it off) every lead matching these filters">
            Tag all matching
          </button>
          <button className="btn" onClick={() => setMakingRule(true)} title="Do something to the leads matching these filters: every day, when you save a call, when the call list runs out... (Automation → Rules)">
            Make a rule
          </button>
          <button className="btn" onClick={() => go('calling')}>Go to Calling</button>
        </div>
      </div>
      {apptDays && <UnmarkedAppointments days={apptDays} onOpen={setOpen} />}
      <table className="grid">
        <thead>
          <tr>
            <th className="pick">
              <input
                type="checkbox"
                aria-label="Tick every lead shown"
                checked={allPicked}
                disabled={!pickable.length}
                onChange={() => setPicked(allPicked ? new Set() : new Set(pickable.map((r) => r.id)))}
              />
            </th>
            <th>Name</th>{sortBy && <th>{sortBy.label}</th>}<th>Phone</th><th>County</th><th>Location</th><th>Type</th><th title="Days since the lead called in">Age</th><th>Batch</th><th title="Your smart lists this lead is in (Automation → Smart lists)">Smart lists</th><th>Attempts</th><th>Last call</th><th>Last outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const can = r.callable && (!r.on_list || replaceNow);
            return (
              <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
                <td className="pick" onClick={(e) => e.stopPropagation()}>
                  {r.on_list && !replaceNow ? (
                    <span className="muted" title="Already on the call list">✓</span>
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={`Tick ${fullName(r)}`}
                      checked={picked.has(r.id)}
                      disabled={!can || !fresh}
                      title={can ? 'Tick to add to the call list' : r.status === 'dead' || r.status === 'invalid' ? 'Bad-number and dead leads can\'t be called. Restore it first.' : 'Your "Can be called when" (Settings → Calling) leaves this lead out.'}
                      onChange={() => toggle(r.id)}
                    />
                  )}
                </td>
                <td>{fullName(r)}{(r.tags as string[]).map((t) => <span key={t} className="tag-chip" style={{ marginLeft: 4, paddingRight: 8 }}>{t}</span>)}</td>
                {sortBy && <td>{showCustomValue(sortBy, r.sort_value == null ? null : String(r.sort_value))}</td>}
                <td>{fmtPhone(r.phone_e164)}</td><td>{r.county ?? ''}</td><td>{[r.city, r.state].filter(Boolean).join(', ')}</td>
                <td title={typeLabel(r.lead_type)}>{r.lead_type ?? ''}</td><td className="nowrap">{fmtLeadAge(r.callin_at)}</td><td>{r.batch_name}</td><td><StatusChips statuses={r.statuses} />{r.on_list && <span className="badge" style={{ marginLeft: 4 }}>on call list</span>}</td>
                <td>{r.attempts_total}</td><td>{fmtDateTime(r.last_call_at)}</td><td>{outcomeLabel(r.last_outcome_code)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <div className="empty">No leads here.</div> : total > perPage && <div className="pager-bottom">{pager}</div>}
      {replacing && callList && (
        <ClearListDialog
          title={`Replace your call list with ${replacing === 'all' ? `all ${total} matching` : `${picked.size} ticked`} lead${(replacing === 'all' ? total : picked.size) === 1 ? '' : 's'}?`}
          confirmLabel="Replace call list"
          current={{ count: onList, savedName: callList.saved_list_id ? callList.name : null, unsaved: callList.unsaved }}
          defaultName={suggestListName(callList.items, callList.name)}
          onConfirm={(name) => (replacing === 'all' ? addAll({ save_current_as: name }) : addPicked({ save_current_as: name }))}
          onCancel={() => setReplacing(null)}
        />
      )}
      {makingRule && (
        <NewRuleFromFilters filter={Object.fromEntries(Object.entries(filters).filter(([, v]) => v))} onClose={() => setMakingRule(false)} />
      )}
      {tagging && (
        <TagMatchingDialog
          total={total}
          tags={tags.map((t) => t.name)}
          scope={filtered ? 'matching these filters' : 'in the CRM'}
          onCancel={() => setTagging(false)}
          onConfirm={async (name, remove) => {
            try {
              const r = await api.post<{ changed: number; matched: number; tag: { id: string; name: string } }>('/leads/tag-matching', { ...filters, tag_name: name, remove });
              const n = `${r.changed} lead${r.changed === 1 ? '' : 's'}`;
              const rest = r.matched - r.changed;
              toast(remove
                ? `Took "${r.tag.name}" off ${n}${rest ? `; ${rest} didn't have it` : ''}`
                : `Tagged ${n} "${r.tag.name}"${rest ? `; ${rest} already were` : ''}`);
              setTagging(false);
              await Promise.all([load(), reloadTags()]);
            } catch (e: any) {
              toast(e.message, 'error');
            }
          }}
        />
      )}
      {changingType && (
        <ChangeTypeDialog
          total={total}
          types={types}
          scope={filtered ? 'matching these filters' : 'in the CRM'}
          onCancel={() => setChangingType(false)}
          onConfirm={async (code) => {
            try {
              const r = await api.post<{ changed: number; matched: number }>('/leads/set-type', { ...filters, set_type: code });
              const to = code ? typeLabel(code) : 'no lead type';
              toast(`${r.changed} lead${r.changed === 1 ? '' : 's'} changed to ${to}${r.matched > r.changed ? `; ${r.matched - r.changed} already were` : ''}`);
              setChangingType(false);
              // The type filter may no longer match, so show where the leads went.
              if (leadType) setLeadType(code ?? 'none');
              else await load();
            } catch (e: any) {
              toast(e.message, 'error');
            }
          }}
        />
      )}
      {open && (
        <LeadViewer
          id={open}
          list={rows.map((r) => ({ id: r.id, name: fullName(r), status: r.status, phone: r.phone_e164, county: r.county }))}
          onClose={() => { setOpen(null); void load(); void reloadTags(); }}
        />
      )}
    </>
  );
}

/** Picks the new lead type for every lead matching the filters. The price follows the type. */
function ChangeTypeDialog(props: {
  total: number;
  types: LeadType[];
  scope: string;
  onConfirm: (code: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const picked = props.types.find((t) => t.code === code);
  const n = `${props.total} lead${props.total === 1 ? '' : 's'}`;
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), props.onCancel())}>
      <form
        className="modal small-modal"
        role="dialog"
        aria-label="Change lead type"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await props.onConfirm(code === 'none' ? null : code);
          } finally {
            setBusy(false);
          }
        }}
      >
        <header><b>Change the lead type of all {n} {props.scope}</b></header>
        <div className="body">
          <label className="field">
            <span>New lead type</span>
            <select value={code} onChange={(e) => setCode(e.target.value)} autoFocus aria-label="New lead type">
              <option value="">Pick a type…</option>
              {props.types.map((t) => (
                <option key={t.code} value={t.code}>{t.label}{t.price_cents != null ? ` · ${fmtMoney(t.price_cents)}` : ''}</option>
              ))}
              <option value="none">No lead type</option>
            </select>
          </label>
          <p className="help">
            {picked ? `Each lead's price becomes ${picked.price_cents != null ? fmtMoney(picked.price_cents) : 'unset'}, so cost in Reports follows. ` : ''}
            Calls and outcomes stay as they are, and each lead keeps the old type in its change history.
          </p>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !code}>Change {n}</button>
            <button className="btn" type="button" onClick={props.onCancel}>Cancel</button>
          </div>
        </div>
      </form>
    </div>
  );
}

/** Puts a tag on every lead matching the filters, or takes one off. A new name makes a new tag. */
function TagMatchingDialog(props: {
  total: number;
  tags: string[];
  scope: string;
  onConfirm: (name: string, remove: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = `${props.total} lead${props.total === 1 ? '' : 's'}`;
  const isNew = !!name.trim() && !props.tags.some((t) => t.toLowerCase() === name.trim().toLowerCase());
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), props.onCancel())}>
      <form
        className="modal small-modal"
        role="dialog"
        aria-label="Tag all matching"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await props.onConfirm(name.trim(), remove);
          } finally {
            setBusy(false);
          }
        }}
      >
        <header><b>Tag all {n} {props.scope}</b></header>
        <div className="body">
          <label className="field">
            <span>Tag</span>
            <input list="tag-matching-names" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={40} aria-label="Tag name" placeholder="Type a tag, new or old" />
            <datalist id="tag-matching-names">{props.tags.map((t) => <option key={t} value={t} />)}</datalist>
          </label>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> Take this tag off instead
          </label>
          <p className="help">{isNew && !remove ? `"${name.trim()}" is a new tag. ` : ''}You can rename or delete tags in Automation → Tags.</p>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !name.trim() || (remove && isNew)}>{remove ? `Take it off ${n}` : `Tag ${n}`}</button>
            <button className="btn" type="button" onClick={props.onCancel}>Cancel</button>
          </div>
        </div>
      </form>
    </div>
  );
}

/** Page buttons for the Leads list: which leads are shown, first/previous/next/last, and how many on a page. */
function Pager(props: { page: number; perPage: number; total: number; onPage: (p: number) => void; onPerPage: (n: number) => void }) {
  const { page, perPage, total } = props;
  const last = Math.max(1, Math.ceil(total / perPage));
  if (!total) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return (
    <span className="pager" role="group" aria-label="Pages">
      {last > 1 && (
        <>
          <button className="btn small" disabled={page <= 1} onClick={() => props.onPage(1)} aria-label="First page">«</button>
          <button className="btn small" disabled={page <= 1} onClick={() => props.onPage(page - 1)} aria-label="Previous page">‹</button>
        </>
      )}
      <span className="muted" aria-label="Leads shown">{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
      {last > 1 && (
        <>
          <button className="btn small" disabled={page >= last} onClick={() => props.onPage(page + 1)} aria-label="Next page">›</button>
          <button className="btn small" disabled={page >= last} onClick={() => props.onPage(last)} aria-label="Last page">»</button>
        </>
      )}
      <select value={perPage} onChange={(e) => props.onPerPage(Number(e.target.value))} aria-label="Leads per page">
        {LEAD_PAGE_SIZES.map((n) => <option key={n} value={n}>{n} a page</option>)}
      </select>
    </span>
  );
}
