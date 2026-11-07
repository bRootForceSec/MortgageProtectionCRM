import { Fragment, useState } from 'react';
import { api, fmtDateTime, fmtPhone, personAge, type LeadDetail } from '../api';
import { useApp } from '../App';
import { useLeadTypes } from '../leadTypes';
import { CustomFieldInput } from './CustomFieldInput';
import { isTypedField, normalizeCustomValue } from '../../shared/customFields';
import { describeBy } from '../../shared/leadEvents';

// Fix a lead's details by hand. Every change is kept with its old value (shown under "Earlier values").

const FIELDS: { key: string; label: string; wide?: boolean }[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'address_line', label: 'Street address', wide: true },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'lender', label: 'Lender' },
  { key: 'loan_amount', label: 'Mortgage amount' },
  { key: 'age', label: 'Age' },
  { key: 'dob', label: 'Date of birth' },
  { key: 'coborrower', label: 'Co-borrower' },
];

function initial(l: LeadDetail['lead']): Record<string, string> {
  const ph = (e: string | null, raw: string | null) => (e ? fmtPhone(e) : raw ?? '');
  return {
    first_name: l.first_name ?? '',
    last_name: l.last_name ?? '',
    phone: ph(l.phone_e164, l.phone_raw),
    email: l.email ?? '',
    address_line: l.address_line ?? '',
    city: l.city ?? '',
    state: l.state ?? '',
    zip: l.zip ?? '',
    lender: l.lender ?? '',
    loan_amount: l.loan_amount_raw ?? (l.loan_amount_cents != null ? String(l.loan_amount_cents / 100) : ''),
    age: personAge(l) != null ? String(personAge(l)) : l.age_raw ?? '',
    dob: l.dob_raw ?? l.dob ?? '',
    coborrower: l.coborrower_raw ?? '',
  };
}

type PhoneRow = { number: string; label: string };

function initialPhones(l: LeadDetail['lead']): PhoneRow[] {
  return l.other_phones.map((p) => ({ number: p.e164 ? fmtPhone(p.e164) : p.raw ?? '', label: p.label ?? '' }));
}

const samePhones = (a: PhoneRow[], b: PhoneRow[]) =>
  a.length === b.length && a.every((x, i) => x.number.trim() === b[i]!.number.trim() && x.label.trim() === b[i]!.label.trim());

/** The lead's other numbers, as a list you can add to, change and remove from. */
function OtherPhones({ rows, onChange }: { rows: PhoneRow[]; onChange: (rows: PhoneRow[]) => void }) {
  const set = (i: number, p: Partial<PhoneRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="field wide">
      <span>Other numbers</span>
      {rows.map((r, i) => (
        <div key={i} className="phone-row">
          <input value={r.number} onChange={(e) => set(i, { number: e.target.value })} placeholder="Number" aria-label={`Other number ${i + 1}`} autoComplete="off" />
          <input value={r.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="What it is (e.g. Work, Spouse)" aria-label={`Other number ${i + 1} label`} autoComplete="off" />
          <button type="button" className="btn small" onClick={() => onChange(rows.filter((_, j) => j !== i))} title="Remove this number">Remove</button>
        </div>
      ))}
      <div className="row">
        <button type="button" className="btn small" onClick={() => onChange([...rows, { number: '', label: '' }])}>Add a number</button>
      </div>
    </div>
  );
}

export function EditLead({ d, onClose, onSaved }: { d: LeadDetail; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useApp();
  const { types } = useLeadTypes();
  const start = initial(d.lead);
  const [v, setV] = useState(start);
  const startPhones = initialPhones(d.lead);
  const [phones, setPhones] = useState(startPhones);
  const [county, setCounty] = useState<string>(d.lead.county ?? '');
  const [leadType, setLeadType] = useState<string>(d.lead.lead_type ?? '');
  const [busy, setBusy] = useState(false);
  // Earlier values and the tags put on and taken off, newest first.
  const history = [
    ...d.changes.map((c) => ({ id: c.id, at: c.created_at, text: `${c.field}: ${c.old_value ?? '(blank)'} → ${c.new_value ?? '(blank)'}` })),
    ...d.events.map((e) => ({
      id: e.id, at: e.at,
      text: e.kind === 'never_dial_override'
        ? `Never dial (${e.tag_name}): ${e.source_name ?? 'gone past'} by you`
        : `Tag ${e.kind === 'tag_added' ? 'added' : 'taken off'}: ${e.tag_name ?? '(deleted)'}, ${describeBy(e.source, e.source_name)}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const startCustom = Object.fromEntries(d.custom.map((c) => [c.field_id, c.value ?? '']));
  const [custom, setCustom] = useState<Record<string, string>>(startCustom);

  const save = async () => {
    const details: Record<string, string> = {};
    for (const f of FIELDS) if ((v[f.key] ?? '').trim() !== (start[f.key] ?? '').trim()) details[f.key] = v[f.key]!.trim();
    const body: Record<string, unknown> = {};
    if (Object.keys(details).length) body.details = details;
    if (!samePhones(phones, startPhones)) {
      body.other_phones = phones.filter((p) => p.number.trim()).map((p) => ({ number: p.number.trim(), label: p.label.trim() || null }));
    }
    if (county.trim() !== (d.lead.county ?? '')) body.county = county.trim() || null;
    if (leadType !== (d.lead.lead_type ?? '')) body.lead_type = leadType || null;
    const customChanged: Record<string, string | null> = {};
    for (const f of d.custom) {
      if ((custom[f.field_id] ?? '').trim() === (startCustom[f.field_id] ?? '').trim()) continue;
      try {
        customChanged[f.field_id] = normalizeCustomValue(f, custom[f.field_id]);
      } catch (e) {
        return toast((e as Error).message, 'error');
      }
    }
    if (Object.keys(customChanged).length) body.custom = customChanged;
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      await api.patch(`/leads/${d.lead.id}`, body);
      toast('Lead updated. The old values are kept.');
      await onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
      <div className="modal" role="dialog" aria-label="Edit lead" style={{ width: 'min(720px, 100%)' }}>
        <header><b>Edit lead</b><button className="btn small" onClick={onClose}>Close <kbd>Esc</kbd></button></header>
        <form
          className="body edit-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {FIELDS.map((f, i) => (
            <Fragment key={f.key}>
              <label className={`field ${f.wide ? 'wide' : ''}`}>
                <span>{f.label}</span>
                <input autoFocus={i === 0} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} autoComplete="off" />
              </label>
              {f.key === 'phone' && <OtherPhones rows={phones} onChange={setPhones} />}
            </Fragment>
          ))}
          <label className="field">
            <span>County it was bought for</span>
            <input value={county} onChange={(e) => setCounty(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            <span>Lead type</span>
            <select value={leadType} onChange={(e) => setLeadType(e.target.value)}>
              <option value="">None</option>
              {types.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </label>
          {d.custom.filter((f) => isTypedField(f) && f.shown !== false).map((f) => (
            <label key={f.field_id} className="field">
              <span>{f.label}{f.required && <em className="warn"> (needed)</em>}</span>
              <CustomFieldInput field={f} value={custom[f.field_id] ?? ''} onChange={(v) => setCustom({ ...custom, [f.field_id]: v })} />
            </label>
          ))}
          <div className="row wide">
            <button type="submit" className="btn primary" disabled={busy}>Save <kbd>Enter</kbd></button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
          {history.length > 0 && (
            <details className="wide">
              <summary>Earlier values and tags ({history.length})</summary>
              <ul className="history">
                {history.map((h) => (
                  <li key={h.id}>
                    <span className="muted">{fmtDateTime(h.at)}</span> {h.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </form>
      </div>
    </div>
  );
}
