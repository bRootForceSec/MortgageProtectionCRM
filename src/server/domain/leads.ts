import type { DB } from '../db/connection.js';
import { nowIso } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { audit } from '../core/audit.js';
import { leadFilterWhere, onCallList, type LeadFilter } from './callList.js';
import { batchPdf } from './pageTurn.js';
import { otherPhones } from './leadPhones.js';
import { currentAppointment } from './appointments.js';

// Reading leads for the Leads page and the lead view, and resolving "same person?" links.

/** The newest 500 leads matching the filter (most recently called first), the total, and which are on the call list. */
export function listLeads(db: DB, f: LeadFilter) {
  const w = leadFilterWhere(f);
  const rows = db
    .prepare(
      `SELECT l.id, l.first_name, l.last_name, l.phone_e164, l.state, l.city, l.county, l.lead_type, l.callin_at, b.name batch_name, s.status, s.attempts_total,
              s.last_call_at, s.last_outcome_code, s.next_due_at, s.appt_result
       FROM lead l JOIN lead_state s ON s.lead_id = l.id JOIN import_batch b ON b.id = l.batch_id
       WHERE ${w.sql}
       ORDER BY coalesce(s.last_call_at, l.created_at) DESC LIMIT 500`,
    )
    .all(w.params) as any[];
  const total = (db.prepare(`SELECT COUNT(*) n FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE ${w.sql}`).get(w.params) as { n: number }).n;
  const listed = onCallList(db, rows.map((r) => r.id));
  return { rows: rows.map((r) => ({ ...r, on_list: listed.has(r.id) })), total };
}

/** Everything the lead view shows: the lead, its state, calls with their outcomes and events, notes, links and changes. */
/** Whether a lead with this id is in the CRM. */
export function leadExists(db: DB, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM lead WHERE id = ?').get(id);
}

export function getLeadDetail(db: DB, importsDir: string, id: string) {
  const lead = db.prepare('SELECT * FROM lead WHERE id = ?').get(id) as any;
  if (!lead) throw new DomainError('lead not found', 404);
  const calls = db
    .prepare(
      `SELECT c.*, n.label from_label FROM call c LEFT JOIN caller_number n ON n.id = c.from_number_id
       WHERE c.lead_id = ? ORDER BY c.requested_at DESC`,
    )
    .all(id) as any[];
  const outcomes = db
    .prepare(
      `SELECT o.*, oc.label, EXISTS (SELECT 1 FROM call_outcome s WHERE s.supersedes_id = o.id) superseded
       FROM call_outcome o JOIN outcome_code oc ON oc.code = o.outcome_code JOIN call c ON c.id = o.call_id
       WHERE c.lead_id = ? ORDER BY o.entered_at`,
    )
    .all(id) as any[];
  const events = db
    .prepare(
      `SELECT e.id, e.call_id, e.source, e.event_type, e.occurred_at, e.received_at FROM call_event e JOIN call c ON c.id = e.call_id
       WHERE c.lead_id = ? ORDER BY e.occurred_at`,
    )
    .all(id) as any[];
  for (const c of calls) {
    c.outcomes = outcomes.filter((o) => o.call_id === c.id);
    c.current_outcome = c.outcomes.filter((o: any) => !o.superseded).at(-1) ?? null;
    c.events = events.filter((e) => e.call_id === c.id);
  }
  const linked = db
    .prepare(
      `SELECT k.id link_id, k.status link_status, k.reason, l.id, l.first_name, l.last_name, b.name batch_name, s.status
       FROM lead_link k JOIN lead l ON l.id = CASE WHEN k.lead_a = @id THEN k.lead_b ELSE k.lead_a END
       JOIN import_batch b ON b.id = l.batch_id JOIN lead_state s ON s.lead_id = l.id
       WHERE k.lead_a = @id OR k.lead_b = @id`,
    )
    .all({ id });
  return {
    lead: { ...lead, extra: lead.extra_json ? JSON.parse(lead.extra_json) : {}, other_phones: otherPhones(db, id) },
    state: db.prepare('SELECT * FROM lead_state WHERE lead_id = ?').get(id),
    batch: db.prepare('SELECT * FROM import_batch WHERE id = ?').get(lead.batch_id),
    import_row: db.prepare('SELECT row_number, warnings_json, raw_json FROM import_row WHERE id = ?').get(lead.import_row_id),
    // The PDF this lead was imported from, when it is still on disk, so the calling screen can show its page.
    source_pdf: lead.source_page != null && !!batchPdf(importsDir, lead.batch_id),
    called_back_at: (db.prepare('SELECT at FROM lead_called_back WHERE lead_id = ?').get(id) as { at: string } | undefined)?.at ?? null,
    appointment: currentAppointment(db, id),
    calls,
    // Notes saved with a call you undid are left out (the undo puts the note back in the form).
    notes: db
      .prepare('SELECT n.* FROM note n LEFT JOIN call c ON c.id = n.call_id WHERE n.lead_id = ? AND c.voided_at IS NULL ORDER BY n.created_at DESC')
      .all(id),
    actions: db.prepare('SELECT * FROM lead_action WHERE lead_id = ? ORDER BY created_at DESC').all(id),
    linked,
    changes: db.prepare('SELECT * FROM lead_change WHERE lead_id = ? ORDER BY created_at DESC').all(id),
    lead_type: lead.lead_type ? db.prepare('SELECT * FROM lead_type WHERE code = ?').get(lead.lead_type) : null,
    /** Area codes of the county the lead was bought for (not the lead's own phone). */
    county_area_codes: lead.county_key
      ? (db.prepare('SELECT area_code FROM county_area_code WHERE county_key = ? ORDER BY area_code').all(lead.county_key) as { area_code: string }[]).map((r) => r.area_code)
      : [],
  };
}

/** The batch PDF and page a lead was imported from, for turning that page upright. */
export function leadPdfPage(db: DB, importsDir: string, id: string) {
  const lead = db.prepare('SELECT batch_id, source_page FROM lead WHERE id = ?').get(id) as { batch_id: string; source_page: number | null } | undefined;
  if (!lead) throw new DomainError('lead not found', 404);
  const file = lead.source_page != null ? batchPdf(importsDir, lead.batch_id) : null;
  if (!file) throw new DomainError('the PDF for this lead is not on this computer', 404);
  return { file, page: lead.source_page! };
}

/** Marks two leads as the same person, different people, or back to a suggestion. */
export function setLinkStatus(db: DB, id: string, status: 'suggested' | 'same_person' | 'different_person') {
  const old = db.prepare('SELECT * FROM lead_link WHERE id = ?').get(id);
  if (!old) throw new DomainError('link not found', 404);
  db.transaction(() => {
    db.prepare('UPDATE lead_link SET status = ?, resolved_at = ? WHERE id = ?').run(status, status === 'suggested' ? null : nowIso(), id);
    audit(db, 'lead_link', id, 'update', old, { status });
  })();
}
