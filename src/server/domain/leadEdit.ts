import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { DomainError } from '../core/errors.js';
import {
  normalizeUsPhone, normalizeState, normalizeZip, normalizeMoneyToCents, normalizeAge, normalizeDob, coborrowerSignal, toText, STATE_TZ, timeZoneFor,
} from './normalize.js';
import { countyKey, countyDisplayName } from './county.js';
import { rebuildLeadState, leadsSharingPhones } from './leadState.js';
import { ageOn } from '../../shared/age.js';
import type { OtherPhone } from '../../shared/phones.js';
import { otherPhones, writeOtherPhones, describePhones } from './leadPhones.js';
import { matchingLeadIds, type LeadFilter } from './callList.js';

// Editing a lead's details by hand. The lead row holds the current value; every change is also written to
// lead_change (old and new value), so nothing you typed over is lost.

export const EDITABLE_FIELDS = [
  'first_name', 'last_name', 'phone', 'email', 'address_line', 'city', 'state', 'zip',
  'lender', 'loan_amount', 'age', 'dob', 'coborrower',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

const LABEL: Record<EditableField, string> = {
  first_name: 'First name', last_name: 'Last name', phone: 'Phone',
  email: 'Email', address_line: 'Address', city: 'City', state: 'State', zip: 'ZIP', lender: 'Lender',
  loan_amount: 'Mortgage amount', age: 'Age', dob: 'Date of birth', coborrower: 'Co-borrower',
};

/** Applies edits inside the caller's transaction. Returns how many fields changed. */
export function editLeadDetails(db: DB, leadId: string, edits: Partial<Record<EditableField, string | null>>): number {
  const lead = db.prepare('SELECT * FROM lead WHERE id = ?').get(leadId) as Record<string, any> | undefined;
  if (!lead) throw new DomainError('lead not found', 404);
  const set: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [field, rawValue] of Object.entries(edits) as [EditableField, string | null][]) {
    if (!EDITABLE_FIELDS.includes(field)) continue;
    const v = toText(rawValue ?? '');
    switch (field) {
      case 'phone': {
        const p = normalizeUsPhone(v);
        if (v && !p.value) problems.push(`${LABEL[field]}: ${p.problem}`);
        set.phone_raw = v || null;
        set.phone_e164 = p.value;
        set.phone_valid = p.value ? 1 : 0;
        break;
      }
      case 'state': {
        const st = normalizeState(v);
        if (v && !st.value) problems.push(`${LABEL[field]}: ${st.problem}`);
        set.state = st.value;
        set.time_zone = st.value ? STATE_TZ[st.value]!.tz : null;
        break;
      }
      case 'zip': {
        const z = normalizeZip(v);
        if (v && !z.value) problems.push(`${LABEL[field]}: ${z.problem}`);
        set.zip = z.value;
        break;
      }
      case 'loan_amount': {
        const m = normalizeMoneyToCents(v);
        if (v && m.value == null) problems.push(`${LABEL[field]}: ${m.problem}`);
        set.loan_amount_cents = m.value;
        set.loan_amount_raw = v || null;
        break;
      }
      case 'age': {
        const a = normalizeAge(v);
        if (v && a.value == null) problems.push(`${LABEL[field]}: ${a.problem}`);
        set.age = a.value;
        set.age_raw = v || null;
        break;
      }
      case 'dob': {
        const b = normalizeDob(v);
        if (v && b.value == null) problems.push(`${LABEL[field]}: ${b.problem}`);
        set.dob = b.value;
        set.dob_raw = v || null;
        break;
      }
      case 'coborrower':
        set.coborrower_raw = v || null;
        set.coborrower_signal = coborrowerSignal(v);
        break;
      default:
        set[field] = v || null;
    }
  }
  if (problems.length) throw new DomainError(problems.join('; '));
  // The age follows a new date of birth, even when an age was typed in the same edit.
  if (typeof set.dob === 'string') set.age = ageOn(set.dob);

  const now = nowIso();
  const change = db.prepare('INSERT INTO lead_change (id, lead_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?)');
  const str = (x: unknown) => (x === null || x === undefined ? null : String(x));
  const changed = Object.entries(set).filter(([col, val]) => str(lead[col]) !== str(val));
  for (const [col, val] of changed) {
    change.run(uuidv7(), leadId, col, str(lead[col]), str(val), now);
  }
  if (changed.length) {
    const cols = changed.map(([c]) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE lead SET ${cols} WHERE id = @id`).run({ ...Object.fromEntries(changed), id: leadId });
  }
  return changed.length;
}

/**
 * Replaces the lead's other numbers (besides the main one) with this list, inside the caller's transaction.
 * Blank rows are dropped. The old list is kept in lead_change. Returns whether anything changed.
 */
export function setOtherPhones(db: DB, leadId: string, list: { number: string; label?: string | null }[], now = nowIso()): boolean {
  const problems: string[] = [];
  const next: OtherPhone[] = [];
  for (const item of list) {
    const raw = toText(item.number);
    if (!raw) continue;
    const p = normalizeUsPhone(raw);
    if (!p.value) {
      problems.push(`Other number "${raw}": ${p.problem}`);
      continue;
    }
    next.push({ raw, e164: p.value, label: toText(item.label ?? '') || null });
  }
  if (problems.length) throw new DomainError(problems.join('; '));
  const before = otherPhones(db, leadId);
  const same = (a: OtherPhone, b: OtherPhone) => a.e164 === b.e164 && (a.e164 ? true : a.raw === b.raw) && a.label === b.label;
  if (before.length === next.length && before.every((b, i) => same(b, next[i]!))) return false;
  db.prepare('INSERT INTO lead_change (id, lead_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?)').run(
    uuidv7(), leadId, 'other_phones', describePhones(before), describePhones(next), now,
  );
  writeOtherPhones(db, leadId, next);
  return true;
}

/**
 * Sets the lead type on these leads, inside the caller's transaction. The price follows the type, so cost per
 * appointment stays right, and both old values are kept in lead_change. Returns how many leads changed.
 */
export function setLeadType(db: DB, leadIds: string[], code: string | null, now = nowIso()): number {
  const t = code ? (db.prepare('SELECT price_cents FROM lead_type WHERE code = ?').get(code) as { price_cents: number | null } | undefined) : null;
  if (code && !t) throw new DomainError(`unknown lead type "${code}"`);
  const price = t?.price_cents ?? null;
  const get = db.prepare('SELECT lead_type, price_cents FROM lead WHERE id = ?');
  const change = db.prepare('INSERT INTO lead_change (id, lead_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?)');
  const update = db.prepare('UPDATE lead SET lead_type = ?, price_cents = ? WHERE id = ?');
  const str = (n: number | null) => (n == null ? null : String(n));
  let changed = 0;
  for (const id of leadIds) {
    const lead = get.get(id) as { lead_type: string | null; price_cents: number | null } | undefined;
    if (!lead) throw new DomainError('lead not found', 404);
    if (lead.lead_type === code) continue;
    change.run(uuidv7(), id, 'lead_type', lead.lead_type, code, now);
    change.run(uuidv7(), id, 'price_cents', str(lead.price_cents), str(price), now);
    update.run(code, price, id);
    changed++;
  }
  return changed;
}

/** Sets the lead type on every lead matching the Leads page filters, in one transaction. */
export function setLeadTypeForMatching(db: DB, f: LeadFilter, code: string | null): { changed: number; matched: number } {
  return db.transaction(() => {
    const ids = matchingLeadIds(db, f);
    return { changed: setLeadType(db, ids, code), matched: ids.length };
  })();
}

/** Changes a lead's details, type or county by hand. Every change is kept in lead_change; the time zone and lead state follow. */
export function editLead(
  db: DB,
  id: string,
  b: {
    lead_type?: string | null;
    county?: string | null;
    details?: Partial<Record<EditableField, string | null>>;
    other_phones?: { number: string; label?: string | null }[];
  },
) {
  const now = nowIso();
  return db.transaction(() => {
    const lead = db.prepare('SELECT * FROM lead WHERE id = ?').get(id) as any;
    if (!lead) throw new DomainError('lead not found', 404);
    const sharedBefore = leadsSharingPhones(db, [id]);
    const change = db.prepare('INSERT INTO lead_change (id, lead_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?)');
    if (b.details) {
      editLeadDetails(db, id, b.details);
      // A new state matters for the county below.
      lead.state = (db.prepare('SELECT state FROM lead WHERE id = ?').get(id) as { state: string | null }).state;
    }
    if (b.other_phones) setOtherPhones(db, id, b.other_phones, now);
    if (b.lead_type !== undefined) setLeadType(db, [id], b.lead_type, now);
    if (b.county !== undefined) {
      if (b.county && !lead.state) throw new DomainError('this lead has no state, so the county can\'t be set');
      const key = b.county ? countyKey(lead.state, b.county) : null;
      if (key !== lead.county_key) {
        change.run(uuidv7(), id, 'county', lead.county_key, key, now);
        db.prepare("UPDATE lead SET county = ?, county_key = ?, county_source = 'manual' WHERE id = ?").run(
          key ? countyDisplayName(key) : null, key, id,
        );
      }
    }
    // The time zone follows the state and, where a state has two, the county.
    const after = db.prepare('SELECT state, county_key, time_zone FROM lead WHERE id = ?').get(id) as { state: string | null; county_key: string | null; time_zone: string | null };
    const tz = timeZoneFor(after.state, after.county_key);
    if (tz !== after.time_zone) db.prepare('UPDATE lead SET time_zone = ? WHERE id = ?').run(tz, id);
    // Leads that shared a phone with this one before the edit are rechecked too.
    rebuildLeadState(db, [id, ...sharedBefore]);
    return { ...(db.prepare('SELECT * FROM lead WHERE id = ?').get(id) as object), other_phones: otherPhones(db, id) };
  })();
}
