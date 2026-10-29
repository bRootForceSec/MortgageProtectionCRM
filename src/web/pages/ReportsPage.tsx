import { useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime, fmtMoney, fmtPhone } from '../api';
import { useApp } from '../App';
import { GroupPicker, useGroups } from '../components/GroupPicker';
import { LeadViewer, type ViewerItem } from '../components/LeadViewer';
import { getStored, setStored } from '../storage';
import { addDays, startOfDay, ymd } from '../when';
import { BatchFilterBar } from '../components/BatchBrowse';
import { batchMatches, groupByImport, type BatchFilter } from '../../shared/batches';
import { APPT_RESULT_LABEL, isApptResult } from '../../shared/appointments';

// Your numbers: activity, by hour, best time to call, by county, local vs out-of-area caller ID, by batch, and against the flier's benchmarks.
// Every number opens the calls or leads behind it.

type Section = 'activity' | 'by_hour' | 'best_time' | 'by_county' | 'by_caller' | 'by_batch' | 'benchmarks';
interface Drill {
  section: Section;
  key: string;
  metric: string;
  title: string;
}
type Report = any;

const RANGES = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  ['7d', 'Last 7 days'],
  ['month', 'This month'],
  ['30d', 'Last 30 days'],
  ['custom', 'Pick dates'],
] as const;
type RangeKey = (typeof RANGES)[number][0];


function rangeFor(k: RangeKey, custom: { from: string; to: string }): { from: Date; to: Date } {
  const today = startOfDay(new Date());
  switch (k) {
    case 'today': return { from: today, to: addDays(today, 1) };
    case 'yesterday': return { from: addDays(today, -1), to: today };
    case 'week': return { from: addDays(today, -today.getDay()), to: addDays(today, 1) };
    case '7d': return { from: addDays(today, -6), to: addDays(today, 1) };
    case 'month': return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: addDays(today, 1) };
    case '30d': return { from: addDays(today, -29), to: addDays(today, 1) };
    case 'custom': {
      const f = custom.from ? new Date(`${custom.from}T00:00:00`) : today;
      const t = custom.to ? addDays(new Date(`${custom.to}T00:00:00`), 1) : addDays(today, 1);
      return { from: f, to: t > f ? t : addDays(f, 1) };
    }
  }
}

const pct = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const num = (x: number | null | undefined, digits = 1) => (x == null ? '–' : x.toFixed(digits));
const CALLER_LABELS: Record<string, string> = { local: 'Local number', out_of_area: 'Out-of-area number', unknown: 'No caller ID recorded' };
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ReportsPage() {
  const { toast } = useApp();
  const [range, setRange] = useState<RangeKey>(() => (getStored('mpcrm.reports.range') as RangeKey) || 'today');
  const [custom, setCustom] = useState({ from: ymd(new Date()), to: ymd(new Date()) });
  const [groups, setGroups, groupParams] = useGroups();
  const [r, setR] = useState<Report | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [open, setOpen] = useState<{ id: string; list: ViewerItem[] } | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { from, to } = rangeFor(range, custom);
  const params = useMemo(
    () => ({ from: from.toISOString(), to: to.toISOString(), tz, ...groupParams }),
    [from.getTime(), to.getTime(), tz, groupParams.counties, groupParams.area_codes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const load = () => api.get<Report>('/reports', params).then(setR).catch((e) => toast(e.message, 'error'));
  useEffect(() => void load(), [params]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setStored('mpcrm.reports.range', range);
  }, [range]);

  /** A number you can click to see the rows behind it. */
  const N = ({ section, k = 'all', metric, title, children }: { section: Section; k?: string; metric: string; title: string; children: React.ReactNode }) => (
    <button className="num" onClick={() => setDrill({ section, key: k, metric, title })} title="Show what's behind this number">{children}</button>
  );

  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  const a = r?.activity;
  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Reports</h2>
          <div className="row" role="group" aria-label="Export this report">
            <span className="muted">Export</span>
            <a className="btn small" href={`/api/reports/export.xlsx?${q}`} title="Every section of the report, plus a sheet with each call">Excel</a>
            <a className="btn small" href={`/api/reports/calls.csv?${q}`} title="One row per call in these dates, to import into another system">Calls (CSV)</a>
            <a className="btn small" href={`/api/reports/export.json?${q}`} title="The whole report and every call, with what each number means, for analysis">Data (JSON)</a>
          </div>
        </div>
        <div className="row">
          <div className="tabs" role="group" aria-label="Date range">
            {RANGES.map(([k, label]) => (
              <button key={k} className={range === k ? 'active' : ''} onClick={() => setRange(k)}>{label}</button>
            ))}
          </div>
          {range === 'custom' && (
            <>
              <label className="field"><span>From</span><input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
              <label className="field"><span>To</span><input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
            </>
          )}
          <GroupPicker groups={groups} onChange={setGroups} />
        </div>
      </div>

      {a && (
        <div className="card">
          <h3>Activity <span className="muted">{from.toLocaleDateString()}{to.getTime() - from.getTime() > 86_400_000 ? ` – ${addDays(to, -1).toLocaleDateString()}` : ''}</span></h3>
          <div className="summary-tiles">
            <div><b><N section="activity" metric="dials" title="Dials">{a.dials}</N></b>Dials</div>
            <div><b><N section="activity" metric="attempts" title="Attempts">{a.attempts}</N></b>Attempts</div>
            <div><b><N section="activity" metric="leads_called" title="Leads called">{a.leads_called}</N></b>Leads called</div>
            <div><b><N section="activity" metric="contacts" title="Contacts">{a.contacts}</N></b>Contacts</div>
            <div><b><N section="activity" metric="conversations" title="Conversations of 2+ minutes">{a.conversations}</N></b>Talks of 2+ min</div>
            <div><b><N section="activity" metric="talk_minutes" title="Calls with talk time">{a.talk_minutes}</N></b>Talk minutes</div>
            <div><b><N section="activity" metric="appointments" title="Appointments set">{a.appointments}</N></b>Appointments</div>
            <div><b><N section="activity" metric="callbacks" title="Callbacks">{a.callbacks}</N></b>Callbacks</div>
            <div><b><N section="activity" metric="bad_numbers" title="Bad numbers">{a.bad_numbers}</N></b>Bad numbers</div>
            <div><b>{num(a.attempts_per_lead)}</b>Attempts per lead</div>
            <div><b>{num(a.dials_per_contact)}</b>Dials per contact</div>
          </div>
          {a.untimed_calls > 0 && <p className="help">{a.untimed_calls} call(s) imported from a spreadsheet fall in these dates. They're left out here and in "by hour" because their real time isn't known, and counted in the county, batch and benchmark numbers.</p>}
        </div>
      )}

      {r?.appointments && <Appointments a={r.appointments} onOpen={(id, list) => setOpen({ id, list })} />}

      {r && (
        <div className="card">
          <h3>By hour <span className="muted">(your time)</span></h3>
          <HourChart rows={r.by_hour} onPick={(h, metric) => setDrill({ section: 'by_hour', key: String(h), metric, title: `${metric === 'contacts' ? 'Contacts' : 'Dials'} at ${hourLabel(h)}` })} />
        </div>
      )}

      {r && (
        <div className="card">
          <h3>Best time to call <span className="muted">(contact rate by the lead's local time, all your calls)</span></h3>
          <BestTime rows={r.best_time} onPick={(key, label) => setDrill({ section: 'best_time', key, metric: 'contacts', title: `Contacts ${label}` })} />
        </div>
      )}

      {r && (
        <div className="card">
          <h3>By county</h3>
          <table className="grid">
            <thead><tr><th>County</th><th>Area codes</th><th>Leads</th><th>Dials</th><th>Attempts</th><th>Contacts</th><th>Appointments</th></tr></thead>
            <tbody>
              {r.by_county.map((c: any) => {
                const name = c.name ? `${c.name}, ${c.state ?? ''}` : 'No county';
                const cell = (metric: string, label: string) => <td><N section="by_county" k={c.key} metric={metric} title={`${label}: ${name}`}>{c[metric]}</N></td>;
                return (
                  <tr key={c.key}>
                    <td>{name}</td><td className="muted">{c.area_codes}</td>
                    {cell('leads', 'Leads')}{cell('dials', 'Dials')}{cell('attempts', 'Attempts')}{cell('contacts', 'Contacts')}{cell('appointments', 'Appointments')}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="help">Leads are every lead you have in the county; the call numbers are for these dates.</p>
        </div>
      )}

      {r && (
        <div className="card">
          <h3>Local vs out-of-area caller ID</h3>
          {r.by_caller.length === 0 ? (
            <p className="muted">No calls in these dates.</p>
          ) : (
            <table className="grid">
              <thead>
                <tr><th>Caller ID</th><th>Dials</th><th>Attempts</th><th>Pickups</th><th>Pickup rate</th><th>Appointments</th><th>Appts per attempt</th><th>Appts per pickup</th><th>Callbacks set</th><th>Called you back</th></tr>
              </thead>
              <tbody>
                {r.by_caller.map((c: any) => {
                  const label = CALLER_LABELS[c.key] ?? c.key;
                  const cell = (metric: string, title: string) => <td><N section="by_caller" k={c.key} metric={metric} title={`${title}: ${label}`}>{c[metric]}</N></td>;
                  return (
                    <tr key={c.key}>
                      <td>{label}</td>
                      {cell('dials', 'Dials')}{cell('attempts', 'Attempts')}{cell('contacts', 'Pickups')}<td>{pct(c.contact_rate)}</td>
                      {cell('appointments', 'Appointments')}<td>{pct(c.appt_rate)}</td><td>{pct(c.appts_per_contact)}</td>{cell('callbacks', 'Callbacks set')}
                      <td><N section="by_caller" k={c.key} metric="called_back" title={`Called you back: ${label}`}>{c.called_back}</N> <span className="muted">({pct(c.called_back_rate)} of leads called)</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="help">
            Local means the number you called from has one of the area codes for the lead's county (Settings)
            (or the lead's own area code, for a county with none set). A pickup is any call where you reached a person.
            Called you back counts leads you ticked "Called me back" in these dates, under the number you last called them from.
          </p>
        </div>
      )}

      {r && <ByBatch rows={r.by_batch} N={N} />}

      {r && <Benchmarks r={r} N={N} onSaved={load} />}

      {drill && <DrillModal params={params} drill={drill} onClose={() => setDrill(null)} onOpen={(id, list) => setOpen({ id, list })} />}
      {open && <LeadViewer id={open.id} list={open.list} onClose={() => setOpen(null)} />}
    </>
  );
}

/** How an appointment went, as Reports shows it: one with no result yet is "not updated yet". */
const apptLabel = (o: string) => (o === 'pending' ? 'Not updated yet' : isApptResult(o) ? APPT_RESULT_LABEL[o] : o);

/** Appointments on these days as the Unitrust calendar shows them: totals, rates by lead type, and each appointment. */
function Appointments({ a, onOpen }: { a: any; onOpen: (id: string, list: ViewerItem[]) => void }) {
  const [all, setAll] = useState(false);
  const rows: any[] = a.rows;
  const shown = all ? rows : rows.slice(0, 20);
  const list: ViewerItem[] = rows.map((x) => ({ id: x.lead_id, name: x.lead_name }));
  return (
    <div className="card">
      <h3>Appointments <span className="muted">(from your Unitrust calendar, by the appointment's day)</span></h3>
      <div className="summary-tiles">
        <div><b>{a.appointments}</b>Appointments</div>
        <div><b>{a.sat}</b>Sat</div>
        <div><b>{a.sold}</b>Sales</div>
        <div><b>{a.prezi}</b>Prezi, no sale</div>
        <div><b>{a.sat_no_sale}</b>Sat, no sale</div>
        <div><b>{a.no_show}</b>No-shows</div>
        <div><b>{a.rescheduled}</b>Rescheduled</div>
        <div><b>{a.pending}</b>Not updated yet</div>
        <div><b>{pct(a.show_rate)}</b>Show rate</div>
        <div><b>{pct(a.close_rate)}</b>Close rate</div>
      </div>
      {a.by_type.length > 0 && (
        <table className="grid">
          <thead><tr><th>Lead type</th><th>Appointments</th><th>Sat</th><th>Sales</th><th>No-shows</th><th>Rescheduled</th><th>Not updated</th><th>Show rate</th><th>Close rate</th></tr></thead>
          <tbody>
            {a.by_type.map((t: any) => (
              <tr key={t.key}>
                <td>{t.label}</td><td>{t.appointments}</td><td>{t.sat}</td><td>{t.sold}</td><td>{t.no_show}</td><td>{t.rescheduled}</td><td>{t.pending}</td>
                <td>{pct(t.show_rate)}</td><td>{pct(t.close_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && (
        <details>
          <summary>Each appointment ({rows.length}{rows.length === 500 ? '+' : ''})</summary>
          <table className="grid">
            <thead><tr><th>Day</th><th>Time</th><th>Lead</th><th>Type</th><th>Status</th><th>In Unitrust</th></tr></thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.id} className="click" onClick={() => onOpen(x.lead_id, list)}>
                  <td>{x.day}</td><td>{x.time ?? ''}</td><td>{x.lead_name}</td><td>{x.lead_type ?? ''}</td>
                  <td><span className={`badge appt-${x.outcome === 'pending' ? 'not_set' : x.outcome}`}>{apptLabel(x.outcome)}</span></td>
                  <td className="muted">{x.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!all && rows.length > shown.length && <button className="btn small" onClick={() => setAll(true)}>Show all {rows.length}</button>}
        </details>
      )}
      <p className="help">
        Sat is sales plus sat with no sale. Show rate is sat out of sat plus no-shows; close rate is sales out of sat.
        Rescheduled counts appointments moved off these days; the new appointment counts on its new day. Numbers change when you update a status in Unitrust
        and the extension sees it, so keep the calendar open in Firefox.
      </p>
    </div>
  );
}

function HourChart({ rows, onPick }: { rows: any[]; onPick: (h: number, metric: string) => void }) {
  if (!rows.length) return <p className="muted">No calls in these dates.</p>;
  const by = new Map(rows.map((x) => [x.hour, x]));
  const lo = Math.min(8, ...rows.map((x) => x.hour));
  const hi = Math.max(20, ...rows.map((x) => x.hour));
  const max = Math.max(1, ...rows.map((x) => x.dials));
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return (
    <div className="hour-chart" role="img" aria-label="Dials and contacts by hour">
      {hours.map((h) => {
        const x = by.get(h) ?? { dials: 0, contacts: 0, appointments: 0 };
        return (
          <div key={h} className="hour">
            <div className="bars">
              <button className="bar dials" style={{ height: `${(x.dials / max) * 100}%` }} onClick={() => x.dials && onPick(h, 'dials')} title={`${hourLabel(h)}: ${x.dials} dials`} aria-label={`${hourLabel(h)} ${x.dials} dials`} />
              <button className="bar contacts" style={{ height: `${(x.contacts / max) * 100}%` }} onClick={() => x.contacts && onPick(h, 'contacts')} title={`${hourLabel(h)}: ${x.contacts} contacts`} aria-label={`${hourLabel(h)} ${x.contacts} contacts`} />
            </div>
            <div className="lbl">{hourLabel(h)}</div>
            <div className="lbl muted">{x.dials || ''}</div>
          </div>
        );
      })}
      <div className="legend"><span className="sw dials" /> Dials <span className="sw contacts" /> Contacts</div>
    </div>
  );
}

function BestTime({ rows, onPick }: { rows: any[]; onPick: (key: string, label: string) => void }) {
  if (!rows.length) return <p className="muted">Not enough calls yet.</p>;
  const by = new Map(rows.map((x) => [x.key, x]));
  const lo = Math.min(8, ...rows.map((x) => x.hour));
  const hi = Math.max(20, ...rows.map((x) => x.hour));
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return (
    <div className="scroll-x">
      <table className="heat">
        <thead><tr><th />{hours.map((h) => <th key={h}>{hourLabel(h)}</th>)}</tr></thead>
        <tbody>
          {WEEKDAYS.map((d, wd) => (
            <tr key={d}>
              <th>{d}</th>
              {hours.map((h) => {
                const x = by.get(`${wd}:${h}`);
                if (!x) return <td key={h} />;
                const rate = x.contact_rate ?? 0;
                return (
                  <td key={h} style={{ background: `rgba(34, 139, 34, ${Math.min(0.85, rate * 1.5 + 0.05)})` }} title={`${d} ${hourLabel(h)}: ${x.contacts} of ${x.attempts} picked up`}>
                    <button className="num" onClick={() => onPick(x.key, `${d} ${hourLabel(h)}`)}>{pct(x.contact_rate)}</button>
                    <div className="small">{x.attempts}</div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="help">Each box: the share of calls someone picked up, and (below) how many calls. A few calls don't say much yet.</p>
    </div>
  );
}

type BatchCol = 'imported_at' | 'leads' | 'cost' | 'never_called' | 'left' | 'dials' | 'reached' | 'booked' | 'cost_per_reached' | 'cost_per_booked';
const BATCH_COLS: [BatchCol, string, string?][] = [
  ['leads', 'Leads'], ['cost', 'Cost'], ['never_called', 'Never called'], ['left', 'Left to call', 'Never called, no answer yet, or a callback'],
  ['dials', 'Dials'], ['reached', 'Reached'], ['booked', 'Booked'], ['cost_per_reached', '$/reached'], ['cost_per_booked', '$/booked'],
];
const SUMMED = ['leads', 'cost', 'never_called', 'left', 'dials', 'reached', 'booked', 'unpriced'] as const;

/** By batch: each bulk import is one line (open it for its files), with search, filters, sorting and "show more". */
function ByBatch({ rows, N }: { rows: any[]; N: any }) {
  const [filter, setFilter] = useState<BatchFilter>({});
  const [sort, setSort] = useState<{ col: BatchCol; desc: boolean }>({ col: 'imported_at', desc: true });
  const [limit, setLimit] = useState(25);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  useEffect(() => setLimit(25), [filter, sort]);
  const groups = useMemo(() => {
    const shown = rows
      .filter((b) => batchMatches({ ...b, lead_types: b.type_codes }, filter))
      .sort((a, b) => (b.imported_at ?? '').localeCompare(a.imported_at ?? ''));
    const all = groupByImport(rows);
    const sizes = new Map(all.filter((g) => g.bulk_id).map((g) => [g.bulk_id!, g.rows.length]));
    const out = groupByImport(shown).map((g) => {
      const sum = Object.fromEntries(SUMMED.map((k) => [k, g.rows.reduce((n: number, b: any) => n + (b[k] ?? 0), 0)])) as Record<(typeof SUMMED)[number], number>;
      return {
        key: g.bulk_id ? `bulk:${g.bulk_id}` : g.rows[0].key,
        bulk: !!g.bulk_id,
        // Only a whole bulk import opens the leads behind its totals; a filtered part of one shows plain numbers.
        whole: !g.bulk_id || g.rows.length === sizes.get(g.bulk_id),
        name: g.bulk_id ? `Bulk import · ${g.rows.length} file${g.rows.length === 1 ? '' : 's'}${g.rows.length < (sizes.get(g.bulk_id) ?? 0) ? ` (of ${sizes.get(g.bulk_id)})` : ''}` : g.rows[0].name,
        imported_at: g.rows.reduce((m: string, b: any) => (b.imported_at && b.imported_at > m ? b.imported_at : m), ''),
        lead_types: [...new Set(g.rows.flatMap((b: any) => (b.lead_types ? b.lead_types.split(', ') : [])))].join(', '),
        ...sum,
        cost_per_reached: sum.reached ? sum.cost / sum.reached : null,
        cost_per_booked: sum.booked ? sum.cost / sum.booked : null,
        rows: g.rows,
      };
    });
    const v = (g: any) => (sort.col === 'imported_at' ? g.imported_at : g[sort.col]);
    return out.sort((a, b) => {
      const x = v(a), y = v(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // blanks last
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return sort.desc ? -c : c;
    });
  }, [rows, filter, sort]);
  const by = (col: BatchCol) => setSort((s) => ({ col, desc: s.col === col ? !s.desc : true }));
  const head = (col: BatchCol, label: string, title?: string) => (
    <th key={col} title={title}>
      <button className="sort" onClick={() => by(col)} aria-label={`Sort by ${label}`}>{label}{sort.col === col ? (sort.desc ? ' ▾' : ' ▴') : ''}</button>
    </th>
  );
  const line = (b: any, child: boolean, drill: boolean) => {
    const cell = (metric: string, label: string, v: React.ReactNode = b[metric]) => (
      <td>{drill ? <N section="by_batch" k={b.key} metric={metric} title={`${label}: ${b.name}`}>{v}</N> : v}</td>
    );
    const money = (x: number | null) => (x == null ? '–' : fmtMoney(x));
    return (
      <tr key={b.key} className={child ? 'child-row' : b.bulk ? 'group-row' : undefined}>
        <td className={child ? 'indent' : undefined}>
          {b.bulk && (
            <button className="btn small" style={{ marginRight: 6 }} aria-label={opened.has(b.key) ? 'Hide files' : 'Show files'}
              onClick={() => setOpened((o) => { const n = new Set(o); if (n.has(b.key)) n.delete(b.key); else n.add(b.key); return n; })}>
              {opened.has(b.key) ? '▾' : '▸'}
            </button>
          )}
          {b.name}<div className="muted small">{fmtDateTime(b.imported_at)}</div>
        </td>
        <td>{b.lead_types}</td>
        {cell('leads', 'Leads')}
        <td>{fmtMoney(b.cost)}{b.unpriced > 0 && <div className="warn small">{b.unpriced} with no price</div>}</td>
        {cell('never_called', 'Never called')}<td>{b.left}</td>{cell('dials', 'Dials')}{cell('reached', 'Reached')}{cell('booked', 'Booked')}
        <td>{money(b.cost_per_reached)}</td><td>{money(b.cost_per_booked)}</td>
      </tr>
    );
  };
  return (
    <div className="card">
      <h3>By batch <span className="muted">(all time · {groups.length} line{groups.length === 1 ? '' : 's'})</span></h3>
      <BatchFilterBar value={filter} onChange={setFilter} />
      <div className="scroll-x">
        <table className="grid">
          <thead>
            <tr>{head('imported_at', 'Batch')}<th>Type</th>{BATCH_COLS.map(([c, l, t]) => head(c, l, t))}</tr>
          </thead>
          <tbody>
            {groups.slice(0, limit).flatMap((g) => [
              line(g, false, g.whole),
              ...(g.bulk && opened.has(g.key) ? g.rows.map((b: any) => line(b, true, true)) : []),
            ])}
          </tbody>
        </table>
      </div>
      {groups.length === 0 && <div className="empty">No batches match.</div>}
      {groups.length > limit && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
          <button className="btn small" onClick={() => setLimit((n) => n + 25)}>Show more ({groups.length - limit} more)</button>
        </div>
      )}
      <p className="help">
        Each bulk import is one line; open it to see its files. Click a column to sort. Reached and booked count leads, not calls.
        How appointments went is in Unitrust. Cost comes from each lead's own price.
      </p>
    </div>
  );
}

function Benchmarks({ r, N, onSaved }: { r: Report; N: any; onSaved: () => void }) {
  const { toast } = useApp();
  const [edit, setEdit] = useState(false);
  const [t, setT] = useState<any>(r.targets);
  useEffect(() => setT(r.targets), [r.targets]);
  const save = async () => {
    try {
      await api.put('/reports/targets', t);
      setEdit(false);
      onSaved();
      toast('Targets saved');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const vs = (actual: number | null, target: number | null) =>
    actual == null || target == null ? '' : actual >= target ? 'good' : 'bad';
  const P = ({ v, on }: { v: number | null; on: (n: number | null) => void }) => (
    <input className="pct" type="number" min={0} max={100} step={0.5} value={v == null ? '' : Math.round(v * 1000) / 10} onChange={(e) => on(e.target.value === '' ? null : Number(e.target.value) / 100)} />
  );
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>By lead type <span className="muted">(all time, against the flier's benchmarks)</span></h3>
        {edit ? (
          <div className="row"><button className="btn small primary" onClick={save}>Save targets</button><button className="btn small" onClick={() => { setT(r.targets); setEdit(false); }}>Cancel</button></div>
        ) : (
          <button className="btn small" onClick={() => setEdit(true)}>Edit targets</button>
        )}
      </div>
      <div className="scroll-x">
        <table className="grid">
          <thead>
            <tr>
              <th>Lead type</th><th>Leads</th><th>Cost</th><th>Never called</th><th>Dials</th><th title="Dials per lead called">Dials/lead</th>
              <th>Contacts</th><th>Appts</th><th>Bad numbers</th><th>Called you back</th>
              <th title="Leads reached, and the share of leads called">Reached</th><th title="Leads booked, and the share of leads called">Booked</th>
              <th>Booked per reached</th><th>$/reached</th><th>$/booked</th>
            </tr>
          </thead>
          <tbody>
            {r.benchmarks.map((b: any) => {
              const cell = (metric: string, label: string) => <td><N section="benchmarks" k={b.key} metric={metric} title={`${label}: ${b.label}`}>{b[metric]}</N></td>;
              const withRate = (metric: string, label: string, rate: number | null) => (
                <td><N section="benchmarks" k={b.key} metric={metric} title={`${label}: ${b.label}`}>{b[metric]}</N> <span className="muted small">{pct(rate)}</span></td>
              );
              return (
                <tr key={b.key}>
                  <td>{b.label}</td>
                  {cell('leads', 'Leads')}
                  <td>{fmtMoney(b.cost)}</td>
                  {cell('never_called', 'Never called')}{cell('dials', 'Dials')}
                  <td>{b.dials_per_lead == null ? '–' : b.dials_per_lead.toFixed(1)}</td>
                  {cell('contacts', 'Contacts')}{cell('appointments', 'Appointments')}{cell('bad_numbers', 'Bad numbers')}{cell('called_back', 'Called you back')}
                  {withRate('reached', 'Reached', b.reached_rate)}{withRate('booked', 'Booked', b.booked_rate)}
                  <td className={vs(b.booked_per_reached, b.booked_target)}>
                    {pct(b.booked_per_reached)}{' '}
                    {edit ? (
                      <span className="muted">target <P v={t.booked_per_contact[b.key] ?? null} on={(n) => setT({ ...t, booked_per_contact: Object.fromEntries(Object.entries({ ...t.booked_per_contact, [b.key]: n }).filter(([, v]) => v != null)) })} />%</span>
                    ) : (
                      <span className="muted">target {pct(b.booked_target)}</span>
                    )}
                  </td>
                  <td>{b.cost_per_reached == null ? '–' : fmtMoney(b.cost_per_reached)}</td>
                  <td>{b.cost_per_booked == null ? '–' : fmtMoney(b.cost_per_booked)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="help">
        Each lead counts under its type now, so fixing a batch's type on Leads moves its history here too.
        Reached and booked count leads; the small % is out of leads called. Targets start from the flier: A 4 of 5, A1 and AA 1 of 4, B 1 of 5, C 1 of 8, D 1 of 10. Sits and apps are tracked in Unitrust.
      </p>
    </div>
  );
}

function DrillModal({ params, drill, onClose, onOpen }: { params: Record<string, string>; drill: Drill; onClose: () => void; onOpen: (id: string, list: ViewerItem[]) => void }) {
  const { toast } = useApp();
  const [d, setD] = useState<{ kind: 'calls' | 'leads'; rows: any[] } | null>(null);
  useEffect(() => {
    api.get<any>('/reports/drill', { ...params, section: drill.section, key: drill.key, metric: drill.metric }).then(setD).catch((e) => toast(e.message, 'error'));
  }, [params, drill, toast]);
  /** The leads behind this number, so the lead view can step through them. */
  const viewerList = (): ViewerItem[] =>
    (d?.rows ?? []).map((r) => ({ id: r.lead_id, name: r.lead_name || '(no name)', status: r.status ?? null, phone: r.phone_e164 ?? r.to_e164, county: r.county }));
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={drill.title}>
        <header><b>{drill.title}{d ? ` (${d.rows.length})` : ''}</b><button className="btn small" onClick={onClose}>Close <kbd>Esc</kbd></button></header>
        <div className="body">
          {d?.kind === 'calls' && (
            <table className="grid">
              <thead><tr><th>Time</th><th>Lead</th><th>County</th><th>To</th><th>Caller ID</th><th>Outcome</th><th>Dials</th><th>Talk</th></tr></thead>
              <tbody>
                {d.rows.map((c) => (
                  <tr key={c.id} className="click" onClick={() => onOpen(c.lead_id, viewerList())}>
                    <td>{c.time_known ? fmtDateTime(c.requested_at) : <span className="muted">from sheet, on or before {new Date(c.requested_at).toLocaleDateString()}</span>}</td>
                    <td>{c.lead_name}</td><td>{c.county ?? ''}</td><td>{fmtPhone(c.to_e164)}</td><td>{c.from_label ?? ''}</td>
                    <td>{c.outcome ?? 'no outcome'}</td><td>{c.dials}</td><td>{c.talk_seconds ? `${Math.round(c.talk_seconds / 60)} min` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d?.kind === 'leads' && (
            <table className="grid">
              <thead><tr><th>Lead</th><th>Phone</th><th>County</th><th>Batch</th><th>Type</th><th>Price</th><th>Status</th><th>Attempts</th></tr></thead>
              <tbody>
                {d.rows.map((l) => (
                  <tr key={l.lead_id} className="click" onClick={() => onOpen(l.lead_id, viewerList())}>
                    <td>{l.lead_name || '(no name)'}</td><td>{fmtPhone(l.phone_e164)}</td><td>{l.county ?? ''}</td><td>{l.batch_name}</td>
                    <td>{l.lead_type ?? ''}</td><td>{fmtMoney(l.price_cents)}</td><td>{l.status?.replace('_', ' ') ?? ''}</td><td>{l.attempts_total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d && !d.rows.length && <div className="empty">Nothing here.</div>}
        </div>
      </div>
    </div>
  );
}
