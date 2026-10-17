import { useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime, fmtMoney, fmtPhone } from '../api';
import { useApp } from '../App';
import { GroupPicker, useGroups } from '../components/GroupPicker';
import { LeadModal } from './LeadsPage';

// Your numbers: activity, by hour, best time to call, by county, by batch, and against the flier's benchmarks.
// Every number opens the calls or leads behind it.

type Section = 'activity' | 'by_hour' | 'best_time' | 'by_county' | 'by_batch' | 'benchmarks';
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

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function rangeFor(k: RangeKey, custom: { from: string; to: string }): { from: Date; to: Date } {
  const today = dayStart(new Date());
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
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ReportsPage() {
  const { toast } = useApp();
  const [range, setRange] = useState<RangeKey>(() => {
    try {
      return (localStorage.getItem('mpcrm.reports.range') as RangeKey) || 'today';
    } catch {
      return 'today';
    }
  });
  const [custom, setCustom] = useState({ from: ymd(new Date()), to: ymd(new Date()) });
  const [groups, setGroups, groupParams] = useGroups();
  const [r, setR] = useState<Report | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { from, to } = rangeFor(range, custom);
  const params = useMemo(
    () => ({ from: from.toISOString(), to: to.toISOString(), tz, ...groupParams }),
    [from.getTime(), to.getTime(), tz, groupParams.counties, groupParams.area_codes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const load = () => api.get<Report>('/reports', params).then(setR).catch((e) => toast(e.message, 'error'));
  useEffect(() => void load(), [params]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      localStorage.setItem('mpcrm.reports.range', range);
    } catch {
      /* storage unavailable */
    }
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
          <a className="btn small" href={`/api/reports/export.xlsx?${q}`}>Export to Excel</a>
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
          <h3>By batch <span className="muted">(all time)</span></h3>
          <div className="scroll-x">
            <table className="grid">
              <thead><tr><th>Batch</th><th>Type</th><th>Leads</th><th>Cost</th><th>Never called</th><th>Dials</th><th>Reached</th><th>Booked</th><th>$/reached</th><th>$/booked</th></tr></thead>
              <tbody>
                {r.by_batch.map((b: any) => {
                  const cell = (metric: string, label: string, v: React.ReactNode = b[metric]) => <td><N section="by_batch" k={b.key} metric={metric} title={`${label}: ${b.name}`}>{v}</N></td>;
                  return (
                    <tr key={b.key}>
                      <td>{b.name}<div className="muted small">{fmtDateTime(b.imported_at)}</div></td>
                      <td>{b.lead_types}</td>
                      {cell('leads', 'Leads')}
                      <td>{fmtMoney(b.cost)}{b.unpriced > 0 && <div className="warn small">{b.unpriced} with no price</div>}</td>
                      {cell('never_called', 'Never called')}{cell('dials', 'Dials')}{cell('reached', 'Reached')}{cell('booked', 'Booked')}
                      <td>{b.cost_per_reached == null ? '–' : fmtMoney(b.cost_per_reached)}</td>
                      <td>{b.cost_per_booked == null ? '–' : fmtMoney(b.cost_per_booked)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="help">Reached and booked count leads, not calls. How appointments went is in Unitrust. Cost comes from each lead's own price.</p>
        </div>
      )}

      {r && <Benchmarks r={r} N={N} onSaved={load} />}

      {drill && <DrillModal params={params} drill={drill} onClose={() => setDrill(null)} onOpen={setOpen} />}
      {open && <LeadModal id={open} onClose={() => setOpen(null)} />}
    </>
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
        <h3>Against the flier's benchmarks <span className="muted">(all time, by lead type)</span></h3>
        {edit ? (
          <div className="row"><button className="btn small primary" onClick={save}>Save targets</button><button className="btn small" onClick={() => { setT(r.targets); setEdit(false); }}>Cancel</button></div>
        ) : (
          <button className="btn small" onClick={() => setEdit(true)}>Edit targets</button>
        )}
      </div>
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Lead type</th><th>Leads</th><th>Reached</th><th>Booked</th><th>Booked per reached</th><th>$/booked</th></tr></thead>
          <tbody>
            {r.benchmarks.map((b: any) => {
              const cell = (metric: string, label: string) => <td><N section="benchmarks" k={b.key} metric={metric} title={`${label}: ${b.label}`}>{b[metric]}</N></td>;
              return (
                <tr key={b.key}>
                  <td>{b.label}</td>
                  {cell('leads', 'Leads')}{cell('reached', 'Reached')}{cell('booked', 'Booked')}
                  <td className={vs(b.booked_per_reached, b.booked_target)}>
                    {pct(b.booked_per_reached)}{' '}
                    {edit ? (
                      <span className="muted">target <P v={t.booked_per_contact[b.key] ?? null} on={(n) => setT({ ...t, booked_per_contact: Object.fromEntries(Object.entries({ ...t.booked_per_contact, [b.key]: n }).filter(([, v]) => v != null)) })} />%</span>
                    ) : (
                      <span className="muted">target {pct(b.booked_target)}</span>
                    )}
                  </td>
                  <td>{b.cost_per_booked == null ? '–' : fmtMoney(b.cost_per_booked)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="help">
        Targets start from the flier: A 4 of 5, A1 and AA 1 of 4, B 1 of 5, C 1 of 8, D 1 of 10. Sits and apps are tracked in Unitrust.
      </p>
    </div>
  );
}

function DrillModal({ params, drill, onClose, onOpen }: { params: Record<string, string>; drill: Drill; onClose: () => void; onOpen: (id: string) => void }) {
  const { toast } = useApp();
  const [d, setD] = useState<{ kind: 'calls' | 'leads'; rows: any[] } | null>(null);
  useEffect(() => {
    api.get<any>('/reports/drill', { ...params, section: drill.section, key: drill.key, metric: drill.metric }).then(setD).catch((e) => toast(e.message, 'error'));
  }, [params, drill, toast]);
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
                  <tr key={c.id} className="click" onClick={() => onOpen(c.lead_id)}>
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
                  <tr key={l.lead_id} className="click" onClick={() => onOpen(l.lead_id)}>
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
