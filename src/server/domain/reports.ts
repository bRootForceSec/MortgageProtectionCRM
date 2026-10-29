import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { groupWhere } from './groupFilter.js';
import { BOOKED_CODES, outcomeDef } from '../../shared/outcomes.js';
import { sqlCodes } from '../db/outcomeCodes.js';
import { DomainError } from '../core/errors.js';
import { loadCallingSettings } from './callingSettings.js';
import { bulkOfBatch } from './importHistory.js';
import { appointmentCounts, appointmentsOnDays, hasAppointments } from './unitrustAppointments.js';

// Reports. Every number is computed from a group of rows (calls or leads), and the same group answers
// "show me the calls behind this number", so a total and its drill-down can never disagree.
//
// - Activity, by hour and by county use the date range. Activity and by hour leave out calls imported from a
//   spreadsheet's Status column, since their real time isn't known; by county includes them.
// - Local vs out-of-area caller ID uses the date range.
// - Best time to call, batches and benchmarks are all-time, for the leads in your county / area-code filter.
// - Calls count only first calls. Appointment calls (the Appointment side of the Calling screen) are counted in the
//   appointments section instead, so dials and pickups keep meaning first calls.

export interface ReportFilter {
  from: string;
  to: string;
  /** Your time zone, for "by hour". */
  tz: string;
  counties?: string[];
  areaCodes?: string[];
}

interface CallRow {
  id: string;
  lead_id: string;
  requested_at: string;
  time_known: number;
  dial_count: number;
  talk_seconds: number | null;
  outcome_code: string | null;
  outcome_label: string | null;
  contact: number;
  /** Ticked "Do not call". */
  do_not_call: number;
  outcome_group: string | null;
  from_label: string | null;
  county_key: string | null;
  county: string | null;
  state: string | null;
  lead_type: string | null;
  batch_id: string;
  time_zone: string | null;
  lead_name: string;
  to_e164: string;
  from_e164: string | null;
  channel: string;
  batch_name: string;
}

interface LeadRow {
  lead_id: string;
  lead_name: string;
  phone_e164: string | null;
  county_key: string | null;
  county: string | null;
  state: string | null;
  lead_type: string | null;
  price_cents: number | null;
  batch_id: string;
  batch_name: string;
  status: string | null;
  attempts_total: number;
  reached: boolean;
  booked: boolean;
  called_back_at: string | null;
}

type CallMetric = 'attempts' | 'dials' | 'leads_called' | 'contacts' | 'conversations' | 'talk_minutes' | 'appointments' | 'callbacks' | 'bad_numbers';
type LeadMetric = 'leads' | 'cost' | 'never_called' | 'reached' | 'booked' | 'called_back';

const CALL_METRICS: Record<CallMetric, { pred: (c: CallRow) => boolean; val: (cs: CallRow[]) => number }> = {
  attempts: { pred: () => true, val: (cs) => cs.length },
  dials: { pred: () => true, val: (cs) => cs.reduce((n, c) => n + c.dial_count, 0) },
  leads_called: { pred: () => true, val: (cs) => new Set(cs.map((c) => c.lead_id)).size },
  contacts: { pred: (c) => c.contact === 1, val: (cs) => cs.length },
  conversations: { pred: (c) => (c.talk_seconds ?? 0) >= 120, val: (cs) => cs.length },
  talk_minutes: { pred: (c) => (c.talk_seconds ?? 0) > 0, val: (cs) => Math.round(cs.reduce((n, c) => n + (c.talk_seconds ?? 0), 0) / 60) },
  appointments: { pred: (c) => !!outcomeDef(c.outcome_code)?.apptSet, val: (cs) => cs.length },
  callbacks: { pred: (c) => !!outcomeDef(c.outcome_code)?.callback, val: (cs) => cs.length },
  bad_numbers: { pred: (c) => c.outcome_group === 'invalid', val: (cs) => cs.length },
};
const LEAD_METRICS: Record<LeadMetric, { pred: (l: LeadRow) => boolean; val: (ls: LeadRow[]) => number }> = {
  leads: { pred: () => true, val: (ls) => ls.length },
  cost: { pred: () => true, val: (ls) => ls.reduce((n, l) => n + (l.price_cents ?? 0), 0) },
  never_called: { pred: (l) => l.attempts_total === 0, val: (ls) => ls.length },
  reached: { pred: (l) => l.reached, val: (ls) => ls.length },
  booked: { pred: (l) => l.booked, val: (ls) => ls.length },
  called_back: { pred: (l) => l.called_back_at != null, val: (ls) => ls.length },
};

function callMetrics(cs: CallRow[], keys: CallMetric[]) {
  return Object.fromEntries(keys.map((k) => [k, CALL_METRICS[k].val(cs.filter(CALL_METRICS[k].pred))])) as Record<CallMetric, number>;
}
function leadMetrics(ls: LeadRow[], keys: LeadMetric[]) {
  return Object.fromEntries(keys.map((k) => [k, LEAD_METRICS[k].val(ls.filter(LEAD_METRICS[k].pred))])) as Record<LeadMetric, number>;
}
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

// ---------- targets (from the IMO flier; editable) ----------

export const ReportTargets = z.object({
  /** Appointments booked per lead reached, by lead type. */
  booked_per_contact: z.record(z.string(), z.number().min(0).max(1)).default({
    'FE-A': 0.8, 'CI-A': 0.8, 'DM-A': 0.8, 'CI-A1': 0.25, 'CI-AA': 0.25, 'DM-AA': 0.25, B: 0.2, C: 0.125, D: 0.1,
  }),
});
export type ReportTargets = z.infer<typeof ReportTargets>;
const TARGETS = 'report_targets';

export function loadTargets(db: DB): ReportTargets {
  const r = ReportTargets.safeParse(getSetting(db, TARGETS) ?? {});
  return r.success ? r.data : ReportTargets.parse({});
}
export function saveTargets(db: DB, input: unknown): ReportTargets {
  const t = ReportTargets.parse(input);
  setSetting(db, TARGETS, t);
  return t;
}

// ---------- loading ----------

function loadCalls(db: DB, f: ReportFilter, range: boolean): CallRow[] {
  const g = groupWhere('l.county_key', f);
  return db
    .prepare(
      `SELECT c.id, c.lead_id, c.requested_at, c.time_known, c.dial_count, c.talk_seconds, c.to_e164, c.from_e164, c.channel,
              o.outcome_code, oc.label outcome_label, coalesce(oc.counts_as_human_contact, 0) contact, coalesce(o.do_not_call, 0) do_not_call, oc.grp outcome_group, n.label from_label,
              l.county_key, l.county, l.state, l.lead_type, l.batch_id, l.time_zone, b.name batch_name,
              trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) lead_name
       FROM call c JOIN lead l ON l.id = c.lead_id JOIN import_batch b ON b.id = l.batch_id
       LEFT JOIN call_outcome o ON o.call_id = c.id AND NOT EXISTS (SELECT 1 FROM call_outcome x WHERE x.supersedes_id = o.id)
       LEFT JOIN outcome_code oc ON oc.code = o.outcome_code
       LEFT JOIN caller_number n ON n.id = c.from_number_id
       WHERE c.initiation_result = 'accepted' AND c.voided_at IS NULL AND coalesce(oc.kind, 'first_call') = 'first_call' AND ${g.sql}
         ${range ? 'AND c.requested_at >= @from AND c.requested_at < @to' : ''}
       ORDER BY c.requested_at`,
    )
    .all({ ...g.params, ...(range ? { from: f.from, to: f.to } : {}) }) as CallRow[];
}

function loadLeads(db: DB, f: ReportFilter, calls: CallRow[]): LeadRow[] {
  const g = groupWhere('l.county_key', f);
  const rows = db
    .prepare(
      `SELECT l.id lead_id, trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) lead_name, l.phone_e164,
              l.county_key, l.county, l.state, l.lead_type, l.price_cents, l.batch_id, b.name batch_name,
              s.status, coalesce(s.attempts_total, 0) attempts_total, cb.at called_back_at
       FROM lead l JOIN import_batch b ON b.id = l.batch_id LEFT JOIN lead_state s ON s.lead_id = l.id
       LEFT JOIN lead_called_back cb ON cb.lead_id = l.id
       WHERE ${g.sql} ORDER BY b.imported_at, l.created_at`,
    )
    .all(g.params) as Omit<LeadRow, 'reached' | 'booked'>[];
  const callsBy = groupBy(calls, (c) => c.lead_id);
  return rows.map((l) => {
    const cs = callsBy.get(l.lead_id) ?? [];
    // Booked: a call ended with "appointment set" (older history may say sat or sold, which also means it was booked).
    const booked = cs.some((c) => c.outcome_code != null && BOOKED_CODES.has(c.outcome_code));
    return { ...l, reached: cs.some((c) => c.contact === 1), booked };
  });
}

// ---------- local time helpers ----------

const fmts = new Map<string, Intl.DateTimeFormat>();
const PARTS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' };
function localParts(iso: string, tz: string | null | undefined, fallback: string): { hour: number; weekday: number; date: string; time: string } {
  const zone = tz || fallback;
  let f = fmts.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...PARTS });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: fallback, ...PARTS });
    }
    fmts.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour ?? 0) % 24;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? 'Sun');
  return { hour, weekday, date: `${p.year}-${p.month}-${p.day}`, time: `${String(hour).padStart(2, '0')}:${p.minute}` };
}

// ---------- building ----------

interface Group {
  key: string;
  calls: CallRow[];
  leads: LeadRow[];
}

const ACTIVITY: CallMetric[] = ['dials', 'attempts', 'leads_called', 'contacts', 'conversations', 'talk_minutes', 'appointments', 'callbacks', 'bad_numbers'];
const HOURLY: CallMetric[] = ['dials', 'attempts', 'contacts', 'appointments'];
const COUNTY_CALLS: CallMetric[] = ['dials', 'attempts', 'contacts', 'appointments'];
const CALLER_MATCH: CallMetric[] = ['dials', 'attempts', 'leads_called', 'contacts', 'appointments', 'callbacks'];
const CALLER_MATCH_ORDER = ['local', 'out_of_area', 'unknown'] as const;
type CallerMatch = (typeof CALLER_MATCH_ORDER)[number];

const areaCode = (e164: string | null | undefined) => (e164 && /^\+1\d{10}$/.test(e164) ? e164.slice(2, 5) : null);

/**
 * Was the caller ID local to the lead? Local means its area code is one you set for the lead's county
 * (Settings); for a county with none set, the lead's own area code. Unknown when no caller ID was recorded.
 */
function callerMatch(c: CallRow, countyCodes: Map<string, Set<string>>): CallerMatch {
  const from = areaCode(c.from_e164);
  if (!from) return 'unknown';
  const codes = (c.county_key && countyCodes.get(c.county_key)) || new Set([areaCode(c.to_e164)].filter(Boolean) as string[]);
  return codes.has(from) ? 'local' : 'out_of_area';
}
function loadCountyCodes(db: DB) {
  const countyCodes = new Map<string, Set<string>>();
  for (const r of db.prepare('SELECT county_key, area_code FROM county_area_code').all() as { county_key: string; area_code: string }[]) {
    const set = countyCodes.get(r.county_key) ?? new Set<string>();
    set.add(r.area_code);
    countyCodes.set(r.county_key, set);
  }
  return countyCodes;
}
const BATCH_LEADS: LeadMetric[] = ['leads', 'cost', 'never_called', 'reached', 'booked'];
const TYPE_LEADS: LeadMetric[] = [...BATCH_LEADS, 'called_back'];
const TYPE_CALLS: CallMetric[] = ['dials', 'attempts', 'contacts', 'appointments', 'bad_numbers'];

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const xs = m.get(k);
    if (xs) xs.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/** All the groups behind the report, by section. Used for both the numbers and the drill-downs. */
function buildGroups(db: DB, f: ReportFilter) {
  const inRange = loadCalls(db, f, true);
  const all = loadCalls(db, f, false);
  const leads = loadLeads(db, f, all);
  const timed = inRange.filter((c) => c.time_known !== 0);

  const activity: Group = { key: 'all', calls: timed, leads: [] };
  const hours = groupBy(timed, (c) => String(localParts(c.requested_at, f.tz, f.tz).hour));
  const hourGroups: Group[] = [...hours].map(([k, cs]) => ({ key: k, calls: cs, leads: [] })).sort((a, b) => +a.key - +b.key);

  const best = groupBy(all.filter((c) => c.time_known !== 0), (c) => {
    const p = localParts(c.requested_at, c.time_zone, f.tz);
    return `${p.weekday}:${p.hour}`;
  });
  const bestGroups: Group[] = [...best].map(([k, cs]) => ({ key: k, calls: cs, leads: [] }));

  const countyCalls = groupBy(inRange, (c) => c.county_key ?? '');
  const countyLeads = groupBy(leads, (l) => l.county_key ?? '');
  const countyKeys = [...new Set([...countyCalls.keys(), ...countyLeads.keys()])];
  const countyGroups: Group[] = countyKeys.map((k) => ({ key: k, calls: countyCalls.get(k) ?? [], leads: countyLeads.get(k) ?? [] }));

  const batchLeads = groupBy(leads, (l) => l.batch_id);
  const allByBatch = groupBy(all, (c) => c.batch_id);
  const batchGroups: Group[] = [...batchLeads].map(([k, ls]) => ({ key: k, calls: allByBatch.get(k) ?? [], leads: ls }));

  const typeLeads = groupBy(leads, (l) => l.lead_type ?? '');
  const allByType = groupBy(all, (c) => c.lead_type ?? '');
  const typeGroups: Group[] = [...typeLeads].map(([k, ls]) => ({ key: k, calls: allByType.get(k) ?? [], leads: ls }));

  const countyCodes = loadCountyCodes(db);
  const byMatch = groupBy(inRange, (c) => callerMatch(c, countyCodes));
  // Leads that called you back in these dates count under the caller ID of your last call to them before that.
  const callsByLead = groupBy(all, (c) => c.lead_id);
  const backByMatch = groupBy(
    leads.filter((l) => l.called_back_at && l.called_back_at >= f.from && l.called_back_at < f.to),
    (l) => {
      const last = (callsByLead.get(l.lead_id) ?? []).filter((c) => c.requested_at <= l.called_back_at!).at(-1);
      return last ? callerMatch(last, countyCodes) : 'unknown';
    },
  );
  const callerGroups: Group[] = CALLER_MATCH_ORDER.filter((k) => byMatch.has(k) || backByMatch.has(k))
    .map((k) => ({ key: k, calls: byMatch.get(k) ?? [], leads: backByMatch.get(k) ?? [] }));

  return { activity, hourGroups, bestGroups, countyGroups, batchGroups, typeGroups, callerGroups, timedCount: timed.length, untimedInRange: inRange.length - timed.length };
}

export function buildReport(db: DB, f: ReportFilter) {
  const g = buildGroups(db, f);
  const targets = loadTargets(db);
  const a = callMetrics(g.activity.calls, ACTIVITY);

  const countyInfo = new Map(
    (db.prepare('SELECT county_key, group_concat(area_code, \', \') codes FROM county_area_code GROUP BY county_key').all() as { county_key: string; codes: string }[])
      .map((r) => [r.county_key, r.codes]),
  );
  const batches = new Map(
    (db.prepare('SELECT id, name, file_name, imported_at FROM import_batch').all() as { id: string; name: string; file_name: string | null; imported_at: string }[])
      .map((b) => [b.id, b]),
  );
  const bulkOf = bulkOfBatch(db);
  const types = new Map((db.prepare('SELECT code, label FROM lead_type').all() as { code: string; label: string }[]).map((t) => [t.code, t.label]));

  const leadRatios = (m: Record<LeadMetric, number>) => ({
    cost_per_reached: ratio(m.cost, m.reached),
    cost_per_booked: ratio(m.cost, m.booked),
  });

  return {
    filter: f,
    activity: {
      ...a,
      attempts_per_lead: ratio(a.attempts, a.leads_called),
      dials_per_contact: ratio(a.dials, a.contacts),
      untimed_calls: g.untimedInRange,
    },
    by_hour: g.hourGroups.map((h) => ({ hour: +h.key, ...callMetrics(h.calls, HOURLY) })),
    best_time: g.bestGroups.map((b) => {
      const [weekday, hour] = b.key.split(':').map(Number);
      const m = callMetrics(b.calls, ['attempts', 'contacts']);
      return { key: b.key, weekday: weekday!, hour: hour!, ...m, contact_rate: ratio(m.contacts, m.attempts) };
    }),
    by_county: g.countyGroups
      .map((c) => {
        const any = c.leads[0] ?? c.calls[0];
        return {
          key: c.key,
          name: any?.county ?? null,
          state: any?.state ?? null,
          area_codes: countyInfo.get(c.key) ?? '',
          leads: c.leads.length,
          ...callMetrics(c.calls, COUNTY_CALLS),
        };
      })
      .sort((x, y) => y.dials - x.dials || y.leads - x.leads),
    by_caller: g.callerGroups.map((c) => {
      const m = callMetrics(c.calls, CALLER_MATCH);
      return {
        key: c.key,
        ...m,
        called_back: c.leads.length,
        called_back_rate: ratio(c.leads.length, m.leads_called),
        contact_rate: ratio(m.contacts, m.attempts),
        appt_rate: ratio(m.appointments, m.attempts),
        appts_per_contact: ratio(m.appointments, m.contacts),
      };
    }),
    by_batch: g.batchGroups
      .map((b) => {
        const m = leadMetrics(b.leads, BATCH_LEADS);
        const info = batches.get(b.key);
        const typesIn = [...new Set(b.leads.map((l) => l.lead_type).filter(Boolean))];
        return {
          key: b.key,
          name: info?.name ?? '',
          file_name: info?.file_name ?? null,
          imported_at: info?.imported_at ?? null,
          lead_types: typesIn.join(', '),
          type_codes: [...new Set(b.leads.map((l) => l.lead_type ?? ''))],
          bulk_id: bulkOf.get(b.key) ?? null,
          left: b.leads.filter((l) => l.status === 'new' || l.status === 'retry' || l.status === 'callback').length,
          ...m,
          dials: CALL_METRICS.dials.val(b.calls),
          unpriced: b.leads.filter((l) => l.price_cents == null).length,
          ...leadRatios(m),
        };
      })
      .sort((x, y) => (y.imported_at ?? '').localeCompare(x.imported_at ?? '')),
    benchmarks: g.typeGroups
      .map((t) => {
        const m = leadMetrics(t.leads, TYPE_LEADS);
        const called = m.leads - m.never_called;
        return {
          key: t.key,
          label: t.key ? types.get(t.key) ?? t.key : 'No lead type',
          ...m,
          ...callMetrics(t.calls, TYPE_CALLS),
          dials_per_lead: ratio(CALL_METRICS.dials.val(t.calls), called),
          reached_rate: ratio(m.reached, called),
          booked_rate: ratio(m.booked, called),
          booked_per_reached: ratio(m.booked, m.reached),
          booked_target: targets.booked_per_contact[t.key] ?? null,
          ...leadRatios(m),
        };
      })
      .sort((x, y) => x.key.localeCompare(y.key)),
    targets,
    appointments: unitrustSection(db, f, types),
  };
}

/** Appointments on the days in the range (by the appointment's day, from Unitrust or logged here), overall and by lead type. */
function unitrustSection(db: DB, f: ReportFilter, types: Map<string, string>) {
  if (!hasAppointments(db)) return null;
  const fromDay = localParts(f.from, f.tz, f.tz).date;
  const toDay = localParts(new Date(Date.parse(f.to) - 1).toISOString(), f.tz, f.tz).date;
  const rows = appointmentsOnDays(db, fromDay, toDay, groupWhere('l.county_key', f));
  return {
    ...appointmentCounts(rows),
    by_type: [...groupBy(rows, (r) => r.lead_type ?? '')]
      .map(([k, rs]) => ({ key: k, label: k ? types.get(k) ?? k : 'No lead type', ...appointmentCounts(rs) }))
      .sort((x, y) => x.key.localeCompare(y.key)),
    rows: rows.slice(0, 500),
  };
}

// ---------- drill-down ----------

export const DrillSpec = z.object({
  section: z.enum(['activity', 'by_hour', 'best_time', 'by_county', 'by_caller', 'by_batch', 'benchmarks']),
  key: z.string().max(200).default('all'),
  metric: z.string().max(40),
});
export type DrillSpec = z.infer<typeof DrillSpec>;

/** The calls or leads behind one number in the report. */
export function drill(db: DB, f: ReportFilter, spec: DrillSpec) {
  const g = buildGroups(db, f);
  const pick: Record<DrillSpec['section'], Group[]> = {
    activity: [g.activity],
    by_hour: g.hourGroups,
    best_time: g.bestGroups,
    by_county: g.countyGroups,
    by_caller: g.callerGroups,
    by_batch: g.batchGroups,
    benchmarks: g.typeGroups,
  };
  const group = spec.section === 'by_batch' && spec.key.startsWith('bulk:')
    ? bulkGroup(db, g.batchGroups, spec.key)
    : pick[spec.section].find((x) => x.key === spec.key) ?? { key: spec.key, calls: [], leads: [] };
  if (spec.metric in CALL_METRICS) {
    const m = CALL_METRICS[spec.metric as CallMetric];
    const calls = group.calls.filter(m.pred);
    if (spec.metric === 'leads_called') {
      const ids = new Set(calls.map((c) => c.lead_id));
      return { kind: 'leads' as const, rows: leadRowsById(db, [...ids]) };
    }
    return { kind: 'calls' as const, rows: calls.map(callOut) };
  }
  if (spec.metric in LEAD_METRICS) {
    const m = LEAD_METRICS[spec.metric as LeadMetric];
    return { kind: 'leads' as const, rows: group.leads.filter(m.pred).map(leadOut) };
  }
  throw new DomainError(`unknown number "${spec.metric}"`);
}

/** Every batch of one bulk import as one group, for "By batch" when its files are shown together. */
function bulkGroup(db: DB, batches: Group[], key: string): Group {
  const bulkOf = bulkOfBatch(db);
  const mine = batches.filter((b) => bulkOf.get(b.key) === key.slice(5));
  return { key, calls: mine.flatMap((b) => b.calls), leads: mine.flatMap((b) => b.leads) };
}

function callOut(c: CallRow) {
  return {
    id: c.id, lead_id: c.lead_id, requested_at: c.requested_at, time_known: c.time_known, lead_name: c.lead_name,
    county: c.county, state: c.state, to_e164: c.to_e164, from_label: c.from_label, outcome_code: c.outcome_code,
    outcome: c.outcome_label, do_not_call: c.do_not_call, dials: c.dial_count, talk_seconds: c.talk_seconds, channel: c.channel,
  };
}
function leadOut(l: LeadRow) {
  return {
    lead_id: l.lead_id, lead_name: l.lead_name, phone_e164: l.phone_e164, county: l.county, state: l.state,
    batch_name: l.batch_name, lead_type: l.lead_type, price_cents: l.price_cents, status: l.status, attempts_total: l.attempts_total,
  };
}
function leadRowsById(db: DB, ids: string[]) {
  if (!ids.length) return [];
  return (
    db
      .prepare(
        `SELECT l.id lead_id, trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) lead_name, l.phone_e164,
                l.county, l.state, b.name batch_name, l.lead_type, l.price_cents, s.status, coalesce(s.attempts_total, 0) attempts_total
         FROM lead l JOIN import_batch b ON b.id = l.batch_id LEFT JOIN lead_state s ON s.lead_id = l.id
         WHERE l.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as ReturnType<typeof leadOut>[]
  );
}

// ---------- per-call export ----------

/**
 * Every call in the date range, one row each, for spreadsheets, other systems or analysis.
 * Includes calls imported from a spreadsheet's Status column (time_known = no), which Activity leaves out.
 * Health fields are never included.
 */
export function reportCalls(db: DB, f: ReportFilter) {
  const countyCodes = loadCountyCodes(db);
  return loadCalls(db, f, true).map((c) => {
    const t = localParts(c.requested_at, f.tz, f.tz);
    return {
      call_id: c.id,
      date: t.date,
      time: c.time_known ? t.time : '',
      time_known: c.time_known ? 'yes' : 'no',
      called_at_utc: c.requested_at,
      lead_id: c.lead_id,
      lead_name: c.lead_name,
      lead_phone: c.to_e164,
      county: c.county ?? '',
      state: c.state ?? '',
      lead_type: c.lead_type ?? '',
      batch: c.batch_name,
      caller_id: c.from_e164 ?? '',
      caller_id_label: c.from_label ?? '',
      caller_id_match: callerMatch(c, countyCodes),
      outcome_code: c.outcome_code ?? '',
      outcome: c.outcome_label ?? '',
      contact: c.contact ? 'yes' : 'no',
      do_not_call: c.do_not_call ? 'yes' : 'no',
      dials: c.dial_count,
      talk_seconds: c.talk_seconds ?? '',
      channel: c.channel,
    };
  });
}

/** The report and its calls in one JSON document, with what each number means, for another system or an AI to read. */
export function reportJson(db: DB, f: ReportFilter) {
  return {
    exported_at: new Date().toISOString(),
    notes: {
      date_range: `Calls from ${f.from} up to (not including) ${f.to}. Local dates and times are in ${f.tz}.`,
      activity: 'Activity and by_hour leave out calls imported from a spreadsheet (time_known = no); by_county and calls include them.',
      all_time: 'best_time, by_batch and benchmarks are all-time for the leads in the county / area-code filter, not just this date range.',
      dials_vs_attempts: 'An attempt is one logged call to a lead; one attempt can be several dials (redials of the same number).',
      contact: 'A contact is a call whose outcome counts as talking to a person. Conversations are calls with 2 minutes or more of talk time.',
      do_not_call: 'do_not_call: the person asked not to be called again. It sits beside the outcome, and the lead goes to the dead pile.',
      rates: 'Rates are fractions from 0 to 1 (null when there is nothing to divide by). Money is in cents.',
      caller_id_match: 'local: the caller ID area code is one set for the lead\'s county (or the lead\'s own area code); out_of_area: it is not; unknown: no caller ID recorded.',
    },
    summary: buildReport(db, f),
    calls: reportCalls(db, f),
  };
}

// ---------- Excel ----------

const CALLER_LABELS: Record<CallerMatch, string> = { local: 'Local number', out_of_area: 'Out-of-area number', unknown: 'No caller ID recorded' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pct = (x: number | null) => (x == null ? '' : Math.round(x * 1000) / 10);
const money = (c: number | null) => (c == null ? '' : Math.round(c) / 100);
const hourLabel = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;

/** The report as sheets for Excel, with every call in the range on the last sheet. */
export function reportSheets(r: ReturnType<typeof buildReport>, calls: ReturnType<typeof reportCalls>) {
  const a = r.activity;
  return [
    {
      name: 'Activity',
      rows: [
        { item: 'From', value: r.filter.from }, { item: 'To', value: r.filter.to },
        { item: 'Dials', value: a.dials }, { item: 'Attempts', value: a.attempts }, { item: 'Leads called', value: a.leads_called },
        { item: 'Contacts', value: a.contacts }, { item: 'Conversations (2+ min)', value: a.conversations },
        { item: 'Talk minutes', value: a.talk_minutes }, { item: 'Appointments', value: a.appointments },
        { item: 'Callbacks', value: a.callbacks }, { item: 'Bad numbers', value: a.bad_numbers },
        { item: 'Attempts per lead', value: a.attempts_per_lead == null ? '' : Math.round(a.attempts_per_lead * 100) / 100 },
        { item: 'Dials per contact', value: a.dials_per_contact == null ? '' : Math.round(a.dials_per_contact * 100) / 100 },
      ],
    },
    { name: 'By hour', rows: r.by_hour.map((h) => ({ hour: hourLabel(h.hour), dials: h.dials, attempts: h.attempts, contacts: h.contacts, appointments: h.appointments })) },
    {
      name: 'Best time to call',
      rows: [...r.best_time]
        .sort((x, y) => x.weekday - y.weekday || x.hour - y.hour)
        .map((b) => ({ day: WEEKDAYS[b.weekday], their_hour: hourLabel(b.hour), attempts: b.attempts, contacts: b.contacts, contact_rate_pct: pct(b.contact_rate) })),
    },
    {
      name: 'By county',
      rows: r.by_county.map((c) => ({ county: c.name, state: c.state, area_codes: c.area_codes, leads: c.leads, dials: c.dials, attempts: c.attempts, contacts: c.contacts, appointments: c.appointments })),
    },
    {
      name: 'Local vs out-of-area',
      rows: r.by_caller.map((c) => ({
        caller_id: CALLER_LABELS[c.key as CallerMatch], dials: c.dials, attempts: c.attempts, leads_called: c.leads_called, contacts: c.contacts,
        appointments: c.appointments, callbacks: c.callbacks, called_you_back: c.called_back,
        contact_rate_pct: pct(c.contact_rate), appt_rate_pct: pct(c.appt_rate),
        appts_per_contact_pct: pct(c.appts_per_contact),
      })),
    },
    {
      name: 'By batch',
      rows: r.by_batch.map((b) => ({
        batch: b.name, imported: b.imported_at, lead_types: b.lead_types, leads: b.leads, cost: money(b.cost), never_called: b.never_called,
        dials: b.dials, reached: b.reached, booked: b.booked,
        cost_per_reached: money(b.cost_per_reached), cost_per_booked: money(b.cost_per_booked),
      })),
    },
    {
      name: 'By lead type',
      rows: r.benchmarks.map((b) => ({
        lead_type: b.label, leads: b.leads, cost: money(b.cost), never_called: b.never_called, dials: b.dials,
        dials_per_lead: b.dials_per_lead == null ? '' : Math.round(b.dials_per_lead * 10) / 10,
        contacts: b.contacts, appointments: b.appointments, bad_numbers: b.bad_numbers, called_you_back: b.called_back,
        reached: b.reached, booked: b.booked, reached_pct: pct(b.reached_rate), booked_pct: pct(b.booked_rate),
        booked_per_reached_pct: pct(b.booked_per_reached), target_pct: pct(b.booked_target),
        cost_per_reached: money(b.cost_per_reached), cost_per_booked: money(b.cost_per_booked),
      })),
    },
    { name: 'Calls', rows: calls },
  ];
}

/**
 * The top bar's numbers for today (or any range), with the daily goals. With `day` (YYYY-MM-DD), also how that day's
 * Unitrust appointments went, once the extension has sent any.
 */
/**
 * Your numbers for a time range (the top bar and the funnel). Dials, leads called, pickups and appointments set
 * count first calls made from `from` to `to`. `day` adds that day's appointments (top bar); `days` adds sat, prezis
 * and sales for appointments on those days (funnel), whether you logged them here or in Unitrust.
 */
export function todayStats(db: DB, from: string, to: string, day?: string, days?: { from: string; to: string }) {
  const row = db
    .prepare(
      `WITH cur AS (
         SELECT c.id, c.lead_id, oc.counts_as_human_contact h, o.outcome_code
         FROM call c LEFT JOIN call_outcome o ON o.call_id = c.id
           AND NOT EXISTS (SELECT 1 FROM call_outcome x WHERE x.supersedes_id = o.id)
         LEFT JOIN outcome_code oc ON oc.code = o.outcome_code
         WHERE c.requested_at >= @from AND c.requested_at < @to AND c.initiation_result = 'accepted' AND c.voided_at IS NULL
           -- First calls only: appointment calls are counted below as sat, prezis and sales.
           AND coalesce(oc.kind, 'first_call') = 'first_call'
           -- Calls from a spreadsheet's history have a date but no real time, so they aren't today's work (same as Reports).
           AND c.time_known <> 0)
       SELECT COUNT(DISTINCT id) attempts, COUNT(DISTINCT lead_id) unique_leads,
              (SELECT coalesce(SUM(dial_count), 0) FROM call WHERE id IN (SELECT id FROM cur)) dials,
              COUNT(DISTINCT CASE WHEN h = 1 THEN id END) human_contacts,
              COUNT(DISTINCT CASE WHEN outcome_code IN ${sqlCodes((o) => o.apptSet)} THEN id END) appointments,
              COUNT(DISTINCT CASE WHEN outcome_code IN ${sqlCodes((o) => o.callback)} THEN id END) callbacks
       FROM cur`,
    )
    .get({ from, to }) as Record<string, number>;
  const appts = day && hasAppointments(db) ? appointmentCounts(appointmentsOnDays(db, day, day)) : null;
  const inRange = days ? appointmentCounts(appointmentsOnDays(db, days.from, days.to)) : null;
  const funnel = inRange ? { sat: inRange.sat, prezis: inRange.prezis, sales: inRange.sold } : null;
  return { ...row, goals: loadCallingSettings(db).goals, appts, funnel };
}
