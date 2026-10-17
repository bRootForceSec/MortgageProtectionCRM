import { useState } from 'react';
import { api, fmtDateTime, fmtPhone, type LeadDetail } from '../api';
import { useApp } from '../App';
import { useLeadTypes } from '../pages/ImportPage';

// Fix a lead's details by hand. Every change is kept with its old value (shown under "Earlier values").

const FIELDS: { key: string; label: string; wide?: boolean }[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'phone', label: 'Phone' },
  { key: 'phone2', label: 'Alternate phone' },
  { key: 'phone3', label: 'Called in from' },
  { key: 'email', label: 'Email' },
  { key: 'address_line', label: 'Street address', wide: true },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'lender', label: 'Lender' },
  { key: 'loan_amount', label: 'Mortgage amount' },
  { key: 'age', label: 'Age' },
  { key: 'coborrower', label: 'Co-borrower' },
];

function initial(l: LeadDetail['lead']): Record<string, string> {
  const ph = (e: string | null, raw: string | null) => (e ? fmtPhone(e) : raw ?? '');
  return {
    first_name: l.first_name ?? '',
    last_name: l.last_name ?? '',
    phone: ph(l.phone_e164, l.phone_raw),
    phone2: ph(l.phone2_e164, l.phone2_raw),
    phone3: ph(l.phone3_e164, l.phone3_raw),
    email: l.email ?? '',
    address_line: l.address_line ?? '',
    city: l.city ?? '',
    state: l.state ?? '',
    zip: l.zip ?? '',
    lender: l.lender ?? '',
    loan_amount: l.loan_amount_raw ?? (l.loan_amount_cents != null ? String(l.loan_amount_cents / 100) : ''),
    age: l.age != null ? String(l.age) : l.age_raw ?? '',
    coborrower: l.coborrower_raw ?? '',
  };
}

export function EditLead({ d, onClose, onSaved }: { d: LeadDetail; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useApp();
  const { types } = useLeadTypes();
  const start = initial(d.lead);
  const [v, setV] = useState(start);
  const [county, setCounty] = useState<string>(d.lead.county ?? '');
  const [leadType, setLeadType] = useState<string>(d.lead.lead_type ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const details: Record<string, string> = {};
    for (const f of FIELDS) if ((v[f.key] ?? '').trim() !== (start[f.key] ?? '').trim()) details[f.key] = v[f.key]!.trim();
    const body: Record<string, unknown> = {};
    if (Object.keys(details).length) body.details = details;
    if (county.trim() !== (d.lead.county ?? '')) body.county = county.trim() || null;
    if (leadType !== (d.lead.lead_type ?? '')) body.lead_type = leadType || null;
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
            <label key={f.key} className={`field ${f.wide ? 'wide' : ''}`}>
              <span>{f.label}</span>
              <input autoFocus={i === 0} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} autoComplete="off" />
            </label>
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
          <div className="row wide">
            <button type="submit" className="btn primary" disabled={busy}>Save <kbd>Enter</kbd></button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
          {d.changes.length > 0 && (
            <details className="wide">
              <summary>Earlier values ({d.changes.length})</summary>
              <ul className="history">
                {d.changes.map((c) => (
                  <li key={c.id}>
                    <span className="muted">{fmtDateTime(c.created_at)}</span> {c.field}: {c.old_value ?? '(blank)'} → {c.new_value ?? '(blank)'}
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
