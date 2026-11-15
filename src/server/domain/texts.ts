import type { DB } from '../db/connection.js';
import { nowIso } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { CURRENT_OUTCOME } from '../db/sql.js';
import { sqlCodes } from '../db/outcomeCodes.js';
import { loadCallingSettings } from './callingSettings.js';
import { leadCustomValues } from './customFields.js';
import { currentAppointment } from './appointments.js';
import { logLeadEvent, neverDialOf } from './tags.js';
import { groupWhere, type GroupFilter } from './groupFilter.js';
import { showCustomValue } from '../../shared/customFields.js';
import { fillText, niceName } from '../../shared/texts.js';

// Text templates filled in for one lead, the reason a lead must not be texted, and the log of texts sent (lead_event,
// kind `texted`, with the template's id and name). The templates themselves are `texts` in calling settings.

/** "Tuesday, Nov 18 at 3:00 PM" (or without the time) from an appointment's wall time, "YYYY-MM-DD[THH:MM]". */
function apptWords(wall: string): string {
  const [day, time] = wall.split('T');
  const [y, m, d] = day!.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (!time) return date;
  const [h, min] = time.split(':').map(Number) as [number, number];
  return `${date} at ${h % 12 || 12}:${String(min).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Every value a text can fill in for this lead, by placeholder name (any case): its own fields, your fields by name, the sheet's other columns. */
export function textValues(db: DB, leadId: string): Record<string, string> {
  const l = db.prepare('SELECT * FROM lead WHERE id = ?').get(leadId) as Record<string, any> | undefined;
  if (!l) throw new DomainError('lead not found', 404);
  const extra = l.extra_json ? (JSON.parse(l.extra_json) as Record<string, string>) : {};
  const out: Record<string, string> = { ...extra };
  for (const f of leadCustomValues(db, leadId)) out[f.label] = showCustomValue(f, f.value);
  const first = niceName(l.first_name);
  const last = niceName(l.last_name);
  const appt = currentAppointment(db, leadId);
  Object.assign(out, {
    first_name: first,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(' '),
    lender: l.lender ?? '',
    loan_amount: l.loan_amount_cents != null ? `$${Math.round(l.loan_amount_cents / 100).toLocaleString('en-US')}` : '',
    address: l.address_line ?? '',
    city: niceName(l.city),
    state: l.state ?? '',
    zip: l.zip ?? '',
    county: l.county ?? '',
    age: l.age != null ? String(l.age) : '',
    email: l.email ?? '',
    lead_id: l.source_lead_id ?? '',
    appointment: appt ? apptWords(appt.scheduled_for) : '',
    my_name: loadCallingSettings(db).scripts.agent_name,
  });
  return out;
}

/** Why this lead must not be texted, or null: a never-dial tag, or a call where they asked not to be called. */
export function textBlock(db: DB, leadId: string): string | null {
  const never = neverDialOf(db, [leadId]).get(leadId);
  if (never) return `tagged ${never.tag}, which is never dialed or texted`;
  const dnc = db
    .prepare(`SELECT 1 FROM call c JOIN call_outcome o ON o.call_id = c.id AND ${CURRENT_OUTCOME} WHERE c.lead_id = ? AND c.voided_at IS NULL AND o.do_not_call = 1`)
    .get(leadId);
  return dnc ? 'they asked not to be contacted again' : null;
}

/** Each of your texts filled in for this lead, with the placeholders it has nothing for, and why it can't be texted (if so). */
export function textsForLead(db: DB, leadId: string) {
  const values = textValues(db, leadId);
  return {
    blocked: textBlock(db, leadId),
    texts: loadCallingSettings(db).texts.map((t) => ({ id: t.id, name: t.name, ...fillText(t.body, values) })),
  };
}

/** Notes on the lead that you texted it (from your phone). Refused for a lead that must not be texted. */
export function logTexted(db: DB, leadId: string, templateId: string, now = nowIso()) {
  const t = loadCallingSettings(db).texts.find((x) => x.id === templateId);
  if (!t) throw new DomainError('that text is gone', 404);
  return db.transaction(() => {
    const why = textBlock(db, leadId);
    if (why) throw new DomainError(`Not texted: ${why}`, 409);
    logLeadEvent(db, leadId, 'texted', { source_id: t.id, source_name: t.name }, now);
    return { logged: true };
  })();
}

/**
 * Texts sent in the dates, by template: how many, to how many leads, and how many of those leads had an appointment
 * set on a call after their first text in the dates. Null when none were sent.
 */
export function textSection(db: DB, from: string, to: string, groups: GroupFilter = {}) {
  const g = groupWhere('l.county_key', groups);
  const rows = db
    .prepare(
      `WITH sent AS (
         SELECT e.lead_id, e.source_name name, MIN(e.at) first_at, COUNT(*) n
         FROM lead_event e JOIN lead l ON l.id = e.lead_id
         WHERE e.kind = 'texted' AND e.at >= @from AND e.at < @to AND ${g.sql}
         GROUP BY e.lead_id, e.source_name)
       SELECT name, SUM(n) texts, COUNT(*) leads,
         SUM(EXISTS (SELECT 1 FROM call c JOIN call_outcome o ON o.call_id = c.id AND ${CURRENT_OUTCOME}
                     WHERE c.lead_id = sent.lead_id AND c.voided_at IS NULL AND c.requested_at > sent.first_at
                       AND o.outcome_code IN ${sqlCodes((d) => d.apptSet)})) booked
       FROM sent GROUP BY name ORDER BY texts DESC, name`,
    )
    .all({ ...g.params, from, to }) as { name: string; texts: number; leads: number; booked: number }[];
  if (!rows.length) return null;
  const all = db
    .prepare(
      `SELECT COUNT(*) texts, COUNT(DISTINCT e.lead_id) leads FROM lead_event e JOIN lead l ON l.id = e.lead_id
       WHERE e.kind = 'texted' AND e.at >= @from AND e.at < @to AND ${g.sql}`,
    )
    .get({ ...g.params, from, to }) as { texts: number; leads: number };
  const booked = db
    .prepare(
      `SELECT COUNT(*) n FROM (SELECT e.lead_id, MIN(e.at) first_at FROM lead_event e JOIN lead l ON l.id = e.lead_id
         WHERE e.kind = 'texted' AND e.at >= @from AND e.at < @to AND ${g.sql} GROUP BY e.lead_id) t
       WHERE EXISTS (SELECT 1 FROM call c JOIN call_outcome o ON o.call_id = c.id AND ${CURRENT_OUTCOME}
                     WHERE c.lead_id = t.lead_id AND c.voided_at IS NULL AND c.requested_at > t.first_at AND o.outcome_code IN ${sqlCodes((d) => d.apptSet)})`,
    )
    .get({ ...g.params, from, to }) as { n: number };
  return { ...all, booked: booked.n, rows };
}
