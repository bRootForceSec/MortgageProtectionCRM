import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { DomainError } from './calls.js';
import {
  normalizeUsPhone, normalizeState, normalizeZip, normalizeMoneyToCents, normalizeAge, coborrowerSignal, toText, STATE_TZ,
} from './normalize.js';

// Editing a lead's details by hand. The lead row holds the current value; every change is also written to
// lead_change (old and new value), so nothing you typed over is lost.

export const EDITABLE_FIELDS = [
  'first_name', 'last_name', 'phone', 'phone2', 'phone3', 'email', 'address_line', 'city', 'state', 'zip',
  'lender', 'loan_amount', 'age', 'coborrower',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

const LABEL: Record<EditableField, string> = {
  first_name: 'First name', last_name: 'Last name', phone: 'Phone', phone2: 'Alternate phone', phone3: 'Called-in-from phone',
  email: 'Email', address_line: 'Address', city: 'City', state: 'State', zip: 'ZIP', lender: 'Lender',
  loan_amount: 'Mortgage amount', age: 'Age', coborrower: 'Co-borrower',
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
      case 'coborrower':
        set.coborrower_raw = v || null;
        set.coborrower_signal = coborrowerSignal(v);
        break;
      default:
        set[field] = v || null;
    }
  }
  if (problems.length) throw new DomainError(problems.join('; '));

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
