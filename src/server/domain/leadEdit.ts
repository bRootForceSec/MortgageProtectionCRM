import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { DomainError } from '../core/errors.js';
import {
  normalizeUsPhone, normalizeState, normalizeZip, normalizeMoneyToCents, normalizeAge, normalizeDob, ageOn, coborrowerSignal, toText, STATE_TZ, timeZoneFor,
} from './normalize.js';
import { countyKey, countyDisplayName } from './county.js';
import { rebuildLeadState, leadsSharingPhones } from './leadState.js';

// Editing a lead's details by hand. The lead row holds the current value; every change is also written to
// lead_change (old and new value), so nothing you typed over is lost.

export const EDITABLE_FIELDS = [
  'first_name', 'last_name', 'phone', 'phone2', 'phone3', 'email', 'address_line', 'city', 'state', 'zip',
  'lender', 'loan_amount', 'age', 'dob', 'coborrower',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

const LABEL: Record<EditableField, string> = {
  first_name: 'First name', last_name: 'Last name', phone: 'Phone', phone2: 'Alternate phone', phone3: 'Called-in-from phone',
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
      case 'phone':
      case 'phone2':
      case 'phone3': {
        const p = normalizeUsPhone(v);
        if (v && !p.value) problems.push(`${LABEL[field]}: ${p.problem}`);
        set[`${field}_raw`] = v || null;
        set[`${field}_e164`] = p.value;
        if (field === 'phone') set.phone_valid = p.value ? 1 : 0;
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

/** Changes a lead's details, type or county by hand. Every change is kept in lead_change; the time zone and lead state follow. */
export function editLead(
  db: DB,
  id: string,
  b: { lead_type?: string | null; county?: string | null; details?: Partial<Record<EditableField, string | null>> },
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
    if (b.lead_type !== undefined && b.lead_type !== lead.lead_type) {
      const t = b.lead_type ? (db.prepare('SELECT price_cents FROM lead_type WHERE code = ?').get(b.lead_type) as { price_cents: number | null } | undefined) : null;
      if (b.lead_type && !t) throw new DomainError(`unknown lead type "${b.lead_type}"`);
      change.run(uuidv7(), id, 'lead_type', lead.lead_type, b.lead_type, now);
      // The price follows the type, so cost per appointment stays right.
      change.run(uuidv7(), id, 'price_cents', lead.price_cents == null ? null : String(lead.price_cents), t?.price_cents == null ? null : String(t.price_cents), now);
      db.prepare('UPDATE lead SET lead_type = ?, price_cents = ? WHERE id = ?').run(b.lead_type, t?.price_cents ?? null, id);
    }
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
    return db.prepare('SELECT * FROM lead WHERE id = ?').get(id);
  })();
}
