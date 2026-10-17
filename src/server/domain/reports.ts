import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../ai/settings.js';
import { groupWhere } from './groupFilter.js';
import { CURRENT_RESULT_SQL } from './leadState.js';

// Reports. Every number is computed from a group of rows (calls or leads), and the same group answers
// "show me the calls behind this number", so a total and its drill-down can never disagree.
//
// - Activity, by hour and by county use the date range. Activity and by hour leave out calls imported from a
//   spreadsheet's Status column, since their real time isn't known; by county includes them.
// - Best time to call, batches and benchmarks are all-time, for the leads in your county / area-code filter.

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
  from_label: string | null;
  county_key: string | null;
  county: string | null;
  state: string | null;
  lead_type: string | null;
  batch_id: string;
  time_zone: string | null;
  lead_name: string;
  to_e164: string;
  channel: string;
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
  sat: boolean;
  sold: boolean;
  /** Booked, and you've said how it went (sat, sold, no-show or canceled). */
  resolved: boolean;
}

type CallMetric = 'attempts' | 'dials' | 'leads_called' | 'contacts' | 'conversations' | 'talk_minutes' | 'appointments' | 'callbacks' | 'dnc_requests';
type LeadMetric = 'leads' | 'cost' | 'never_called' | 'reached' | 'booked' | 'sat' | 'sold' | 'awaiting_result';

const CALL_METRICS: Record<CallMetric, { pred: (c: CallRow) => boolean; val: (cs: CallRow[]) => number }> = {
  attempts: { pred: () => true, val: (cs) => cs.length },
  dials: { pred: () => true, val: (cs) => cs.reduce((n, c) => n + c.dial_count, 0) },
  leads_called: { pred: () => true, val: (cs) => new Set(cs.map((c) => c.lead_id)).size },
  contacts: { pred: (c) => c.contact === 1, val: (cs) => cs.length },
  conversations: { pred: (c) => (c.talk_seconds ?? 0) >= 120, val: (cs) => cs.length },
  talk_minutes: { pred: (c) => (c.talk_seconds ?? 0) > 0, val: (cs) => Math.round(cs.reduce((n, c) => n + (c.talk_seconds ?? 0), 0) / 60) },
  appointments: { pred: (c) => c.outcome_code === 'appointment', val: (cs) => cs.length },
  callbacks: { pred: (c) => c.outcome_code === 'callback', val: (cs) => cs.length },
  dnc_requests: { pred: (c) => c.outcome_code === 'dnc_request', val: (cs) => cs.length },
};
const LEAD_METRICS: Record<LeadMetric, { pred: (l: LeadRow) => boolean; val: (ls: LeadRow[]) => number }> = {
  leads: { pred: () => true, val: (ls) => ls.length },
  cost: { pred: () => true, val: (ls) => ls.reduce((n, l) => n + (l.price_cents ?? 0), 0) },
  never_called: { pred: (l) => l.attempts_total === 0, val: (ls) => ls.length },
  reached: { pred: (l) => l.reached, val: (ls) => ls.length },
  booked: { pred: (l) => l.booked, val: (ls) => ls.length },
  sat: { pred: (l) => l.sat, val: (ls) => ls.length },
  sold: { pred: (l) => l.sold, val: (ls) => ls.length },
  awaiting_result: { pred: (l) => l.booked && !l.resolved, val: (ls) => ls.length },
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
  sits_per_booked: z.number().min(0).max(1).default(0.8),
  apps_per_sit: z.number().min(0).max(1).default(0.5),
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
      `SELECT c.id, c.lead_id, c.requested_at, c.time_known, c.dial_count, c.talk_seconds, c.to_e164, c.channel,
              o.outcome_code, oc.label outcome_label, coalesce(oc.counts_as_human_contact, 0) contact, n.label from_label,
              l.county_key, l.county, l.state, l.lead_type, l.batch_id, l.time_zone,
              trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) lead_name
       FROM call c JOIN lead l ON l.id = c.lead_id
       LEFT JOIN call_outcome o ON o.call_id = c.id AND NOT EXISTS (SELECT 1 FROM call_outcome x WHERE x.supersedes_id = o.id)
       LEFT JOIN outcome_code oc ON oc.code = o.outcome_code
       LEFT JOIN caller_number n ON n.id = c.from_number_id
       WHERE c.initiation_result = 'accepted' AND c.voided_at IS NULL AND ${g.sql}
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
              s.status, coalesce(s.attempts_total, 0) attempts_total
       FROM lead l JOIN import_batch b ON b.id = l.batch_id LEFT JOIN lead_state s ON s.lead_id = l.id
       WHERE ${g.sql} ORDER BY b.imported_at, l.created_at`,
    )
    .all(g.params) as Omit<LeadRow, 'reached' | 'booked' | 'sat' | 'sold' | 'resolved'>[];
  // Appointments that still stand: not ones whose call you undid.
  const appts = db
    .prepare(
      `SELECT a.lead_id, ${CURRENT_RESULT_SQL} result FROM appointment a
       LEFT JOIN call c ON c.id = a.set_on_call_id
       WHERE c.id IS NULL OR c.voided_at IS NULL`,
    )
    .all() as { lead_id: string; result: string | null }[];
  const byLead = groupBy(appts, (a) => a.lead_id);
  const callsBy = groupBy(calls, (c) => c.lead_id);
  return rows.map((l) => {
    const cs = callsBy.get(l.lead_id) ?? [];
    const as = byLead.get(l.lead_id) ?? [];
    const outs = new Set(cs.map((c) => c.outcome_code));
    const results = new Set(as.map((a) => a.result));
    const sold = outs.has('sold') || results.has('sold');
    const sat = sold || outs.has('sat_no_sale') || results.has('sat_no_sale');
    const booked = sat || outs.has('appointment') || as.length > 0;
    const resolved = sat || results.has('no_show') || results.has('canceled');
    return { ...l, reached: cs.some((c) => c.contact === 1), booked, sat, sold, resolved };
  });
}

// ---------- local time helpers ----------

const fmts = new Map<string, Intl.DateTimeFormat>();
function localParts(iso: string, tz: string | null | undefined, fallback: string): { hour: number; weekday: number } {
  const zone = tz || fallback;
  let f = fmts.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: fallback, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
    }
    fmts.set(zone, f);
  }
  const parts = f.formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun');
  return { hour, weekday };
}

// ---------- building ----------

interface Group {
  key: string;
  calls: CallRow[];
  leads: LeadRow[];
}

const ACTIVITY: CallMetric[] = ['dials', 'attempts', 'leads_called', 'contacts', 'conversations', 'talk_minutes', 'appointments', 'callbacks', 'dnc_requests'];
const HOURLY: CallMetric[] = ['dials', 'attempts', 'contacts', 'appointments'];
const COUNTY_CALLS: CallMetric[] = ['dials', 'attempts', 'contacts', 'appointments'];
const BATCH_LEADS: LeadMetric[] = ['leads', 'cost', 'never_called', 'reached', 'booked', 'sat', 'sold', 'awaiting_result'];

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

  return { activity, hourGroups, bestGroups, countyGroups, batchGroups, typeGroups, timedCount: timed.length, untimedInRange: inRange.length - timed.length };
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
    (db.prepare('SELECT id, name, imported_at, lead_type FROM import_batch').all() as { id: string; name: string; imported_at: string; lead_type: string | null }[])
      .map((b) => [b.id, b]),
  );
  const types = new Map((db.prepare('SELECT code, label FROM lead_type').all() as { code: string; label: string }[]).map((t) => [t.code, t.label]));

  const leadRatios = (m: Record<LeadMetric, number>) => ({
    cost_per_reached: ratio(m.cost, m.reached),
    cost_per_booked: ratio(m.cost, m.booked),
    cost_per_sale: ratio(m.cost, m.sold),
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
    by_batch: g.batchGroups
      .map((b) => {
        const m = leadMetrics(b.leads, BATCH_LEADS);
        const info = batches.get(b.key);
        const typesIn = [...new Set(b.leads.map((l) => l.lead_type).filter(Boolean))];
        return {
          key: b.key,
          name: info?.name ?? '',
          imported_at: info?.imported_at ?? null,
          lead_types: typesIn.join(', '),
          ...m,
          dials: CALL_METRICS.dials.val(b.calls),
          unpriced: b.leads.filter((l) => l.price_cents == null).length,
          ...leadRatios(m),
        };
      })
      .sort((x, y) => (y.imported_at ?? '').localeCompare(x.imported_at ?? '')),
    benchmarks: g.typeGroups
      .map((t) => {
        const m = leadMetrics(t.leads, BATCH_LEADS);
        const resolved = t.leads.filter((l) => l.booked && l.resolved).length;
        return {
          key: t.key,
          label: t.key ? types.get(t.key) ?? t.key : 'No lead type',
          ...m,
          dials: CALL_METRICS.dials.val(t.calls),
          booked_per_reached: ratio(m.booked, m.reached),
          booked_target: targets.booked_per_contact[t.key] ?? null,
          sits_per_booked: ratio(m.sat, resolved),
          sits_target: targets.sits_per_booked,
          apps_per_sit: ratio(m.sold, m.sat),
          apps_target: targets.apps_per_sit,
          ...leadRatios(m),
        };
      })
      .sort((x, y) => x.key.localeCompare(y.key)),
    targets,
  };
}

// ---------- drill-down ----------

export const DrillSpec = z.object({
  section: z.enum(['activity', 'by_hour', 'best_time', 'by_county', 'by_batch', 'benchmarks']),
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
    by_batch: g.batchGroups,
    benchmarks: g.typeGroups,
  };
  const group = pick[spec.section].find((x) => x.key === spec.key) ?? { key: spec.key, calls: [], leads: [] };
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
  throw new Error(`unknown number "${spec.metric}"`);
}

function callOut(c: CallRow) {
  return {
    id: c.id, lead_id: c.lead_id, requested_at: c.requested_at, time_known: c.time_known, lead_name: c.lead_name,
    county: c.county, state: c.state, to_e164: c.to_e164, from_label: c.from_label, outcome_code: c.outcome_code,
    outcome: c.outcome_label, dials: c.dial_count, talk_seconds: c.talk_seconds, channel: c.channel,
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

// ---------- Excel ----------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pct = (x: number | null) => (x == null ? '' : Math.round(x * 1000) / 10);
const money = (c: number | null) => (c == null ? '' : Math.round(c) / 100);
const hourLabel = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;

/** The report as sheets for Excel. */
export function reportSheets(r: ReturnType<typeof buildReport>) {
  const a = r.activity;
  return [
    {
      name: 'Activity',
      rows: [
        { item: 'From', value: r.filter.from }, { item: 'To', value: r.filter.to },
        { item: 'Dials', value: a.dials }, { item: 'Attempts', value: a.attempts }, { item: 'Leads called', value: a.leads_called },
        { item: 'Contacts', value: a.contacts }, { item: 'Conversations (2+ min)', value: a.conversations },
        { item: 'Talk minutes', value: a.talk_minutes }, { item: 'Appointments', value: a.appointments },
        { item: 'Callbacks', value: a.callbacks }, { item: 'Do-not-call requests', value: a.dnc_requests },
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
      name: 'By batch',
      rows: r.by_batch.map((b) => ({
        batch: b.name, imported: b.imported_at, lead_types: b.lead_types, leads: b.leads, cost: money(b.cost), never_called: b.never_called,
        dials: b.dials, reached: b.reached, booked: b.booked, sat: b.sat, sold: b.sold,
        cost_per_reached: money(b.cost_per_reached), cost_per_booked: money(b.cost_per_booked), cost_per_sale: money(b.cost_per_sale),
      })),
    },
    {
      name: 'Benchmarks',
      rows: r.benchmarks.map((b) => ({
        lead_type: b.label, leads: b.leads, reached: b.reached, booked: b.booked, sat: b.sat, sold: b.sold,
        booked_per_reached_pct: pct(b.booked_per_reached), target_pct: pct(b.booked_target),
        sits_per_booked_pct: pct(b.sits_per_booked), sits_target_pct: pct(b.sits_target),
        apps_per_sit_pct: pct(b.apps_per_sit), apps_target_pct: pct(b.apps_target),
        cost_per_booked: money(b.cost_per_booked), cost_per_sale: money(b.cost_per_sale),
      })),
    },
  ];
}
