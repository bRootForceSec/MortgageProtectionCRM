import { useState } from 'react';
import { AppointmentCalendar } from './Calendar';
import { api, fmtDateTime, fmtMoney, fmtPhone, fullName, localTime, type LeadDetail, type Call } from '../api';
import { useApp } from '../App';

const STATUS_LABEL: Record<string, string> = {
  new: 'New', retry: 'Retry', callback: 'Callback', appointment_set: 'Appointment', invalid: 'Invalid number', dead: 'Dead lead', sold: 'Sold',
};

function leadAge(iso: string | null | undefined) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 0) return '';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'} old`;
  const months = Math.floor(days / 30.44);
  return months < 24 ? `${months} months old` : `${(days / 365.25).toFixed(1)} years old`;
}

const COUNTY_SOURCE: Record<string, string> = { page: 'from the lead page', zip: 'from the ZIP code', city: 'from the city', manual: 'set by you' };

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** Header + key facts used on the calling screen and the lead modal. */
export function LeadSummary({
  d, onDial, dialLabel = 'Copy number', dialKey, onEdit, editKey, onChange,
}: {
  d: LeadDetail;
  /** Something on the lead changed here (e.g. the calendar note); reload it. */
  onChange?: () => void;
  /** On the Calling screen: dial (or copy, or show a QR code, per Settings) and start the attempt. */
  onDial?: (e164: string) => void;
  dialLabel?: string;
  dialKey?: string;
  onEdit?: () => void;
  editKey?: string;
}) {
  const l = d.lead;
  const { toast } = useApp();
  const copy = async (e164: string | null = l.phone_e164) => {
    if (!e164) return;
    if (onDial) return onDial(e164);
    try {
      await navigator.clipboard.writeText(e164.replace(/^\+1/, ''));
      toast('Phone number copied');
    } catch {
      toast('Could not copy; select the number instead', 'error');
    }
  };
  const health = [
    ['Heart attack', l.health_heart_raw], ['Stroke', l.health_stroke_raw], ['Cancer', l.health_cancer_raw], ['Diabetes', l.health_diabetes_raw],
  ].filter(([, v]) => v);
  const warnings: string[] = d.import_row?.warnings_json ? JSON.parse(d.import_row.warnings_json) : [];
  const { Passphrase: passphrase, 'Import notes': importNotes, 'Page type': pageType, ...extra } = (l.extra ?? {}) as Record<string, string>;
  const others = [
    ['Alternate', l.phone2_e164, l.phone2_raw],
    ['Called in from', l.phone3_e164, l.phone3_raw],
  ].filter(([, e, r]) => e || r) as [string, string | null, string | null][];
  return (
    <>
      {passphrase && <div className="passphrase">Passphrase: <b>{passphrase}</b></div>}
      <div className="lead-head">
        <div>
          <h2>
            <span className="lead-name">{fullName(l)}</span> {d.state && <StatusBadge status={d.state.status} />}
            {onEdit && <button className="btn small" onClick={onEdit} title="Edit this lead's details">Edit {editKey && <kbd>{editKey}</kbd>}</button>}
          </h2>
          <div className="where">
            {[l.city, l.state].filter(Boolean).join(', ')}
            {l.county && <> · <b>{l.county} County</b></>}
            {l.time_zone && <> · <b>{localTime(l.time_zone)}</b> local</>}
          </div>
        </div>
        <div className="phones">
          <div className="phone-big">{l.phone_e164 ? fmtPhone(l.phone_e164) : <span className="error">no valid phone</span>}</div>
          {l.phone_e164 && <button className="btn small" onClick={() => copy()}>{dialLabel} {dialKey && <kbd>{dialKey}</kbd>}</button>}
          {others.map(([label, e164, raw]) => (
            <div key={label} className="row" style={{ justifyContent: 'flex-end' }}>
              <span className="muted">{label}</span>
              <span className="alt">{e164 ? fmtPhone(e164) : raw}</span>
              {e164 && <button className="btn small" onClick={() => copy(e164)} title={`${dialLabel}: ${label.toLowerCase()} number`}>{onDial ? dialLabel.replace(' number', '') : 'Copy'}</button>}
            </div>
          ))}
        </div>
      </div>
      <div className="facts">
        <Fact label="County" v={l.county ? `${l.county}, ${l.state ?? ''}${l.county_source ? ` (${COUNTY_SOURCE[l.county_source] ?? l.county_source})` : ''}` : null} />
        <Fact label="Lead type" v={l.lead_type ? `${l.lead_type}${l.price_cents != null ? ` · ${fmtMoney(l.price_cents)}` : ''}${pageType ? ` · ${pageType}` : ''}` : pageType} />
        <Fact label="Called in" v={l.callin_at ? `${fmtDateTime(l.callin_at)} · ${leadAge(l.callin_at)}` : l.callin_raw} />
        <Fact label="Lead ID" v={l.source_lead_id} />
        <Fact label="Age" v={l.age ?? l.age_raw} />
        <Fact label="Lender" v={l.lender} />
        <Fact label="Loan amount" v={l.loan_amount_cents != null ? fmtMoney(l.loan_amount_cents) : l.loan_amount_raw} />
        <Fact label="Co-borrower" v={l.coborrower_signal === 'yes' ? 'Yes' : l.coborrower_raw ? `Unknown (sheet says "${l.coborrower_raw}")` : 'Unknown'} />
        <Fact label="Tobacco" v={l.tobacco_raw} />
        <Fact label="Address" v={[l.address_line, l.zip].filter(Boolean).join(' ')} />
        <Fact label="Batch" v={`${d.batch.name}${d.batch.cost_per_lead_cents != null ? ` · ${fmtMoney(d.batch.cost_per_lead_cents)}/lead` : ''}`} />
        <Fact label="Attempts" v={d.state ? `${d.state.attempts_total}${d.state.last_call_at ? ` · last ${fmtDateTime(d.state.last_call_at)}` : ''}` : ''} />
        {health.length > 0 && (
          <div>
            <label>Health (from sheet)</label>
            <span className="sensitive">{health.map(([k, v]) => `${k}: ${v}`).join(' · ')}</span>
          </div>
        )}
        {Object.entries(extra).map(([k, v]) => <Fact key={k} label={k} v={v} />)}
        {l.source_page != null && <Fact label="PDF page" v={l.source_page} />}
      </div>
      {d.appointments.length > 0 && (
        <div className="card" style={{ padding: 10 }}>
          {d.appointments.map((a) => (
            <div key={a.id}>
              Appointment <b>{a.scheduled_for ? fmtDateTime(a.scheduled_for) : a.result ? '' : 'needs a date'}</b>
              {a.internal_status !== 'canceled' && <> · <AppointmentResult id={a.id} value={a.result} /></>}
              {a.recorded_via === 'sheet_import' && <span className="muted"> (from your spreadsheet)</span>}
              {a.from_e164 && <> · set from <b>{a.from_label ?? fmtPhone(a.from_e164)}</b> ({fmtPhone(a.from_e164)})</>}
              {a.internal_status === 'canceled' && <span className="muted"> · canceled{a.notes ? ` ${a.notes}` : ''}</span>}
              <AppointmentCalendar a={a} onChange={onChange ?? (() => {})} />
            </div>
          ))}
        </div>
      )}
      {d.linked.length > 0 && <LinkedLeads d={d} />}
      {(warnings.length > 0 || importNotes) && <p className="help">Import notes: {[importNotes, ...warnings].filter(Boolean).join(' ')}</p>}
    </>
  );
}

const RESULT_LABELS: Record<string, string> = {
  sat_no_sale: 'Sat, no sale', sold: 'Sold (app written)', no_show: 'No-show', rescheduled: 'Rescheduled', canceled: 'Canceled',
};

/** How the appointment went, for your numbers (the IMO site stays the official record). */
function AppointmentResult({ id, value }: { id: string; value: string | null }) {
  const [v, setV] = useState(value ?? '');
  const [err, setErr] = useState('');
  const set = async (next: string) => {
    if (next === 'rescheduled') return setErr('Reschedule from the Today page so the new time is saved.');
    try {
      await api.post(`/appointments/${id}/result`, { result: next || 'cleared' });
      setV(next);
      setErr('');
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <>
      <select value={v} onChange={(e) => set(e.target.value)} aria-label="How it went" disabled={v === 'rescheduled'}>
        <option value="">How did it go?</option>
        {Object.entries(RESULT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {err && <span className="warn"> {err}</span>}
    </>
  );
}

function Fact({ label, v }: { label: string; v: unknown }) {
  if (v === null || v === undefined || v === '') return null;
  return (
    <div>
      <label>{label}</label>
      <span>{String(v)}</span>
    </div>
  );
}

function LinkedLeads({ d }: { d: LeadDetail }) {
  const { toast } = useApp();
  const [links, setLinks] = useState(d.linked);
  const set = async (id: string, status: string) => {
    await api.post(`/lead-links/${id}`, { status });
    setLinks((ls) => ls.map((l) => (l.link_id === id ? { ...l, link_status: status } : l)));
    toast('Saved');
  };
  return (
    <div className="card" style={{ padding: 10 }}>
      <b>Same phone as:</b>
      {links.map((k) => (
        <div key={k.link_id} className="row">
          <span>{fullName(k)} · {k.batch_name}</span> <StatusBadge status={k.status} />
          {k.link_status === 'suggested' ? (
            <>
              <button className="btn small" onClick={() => set(k.link_id, 'same_person')}>Same person</button>
              <button className="btn small" onClick={() => set(k.link_id, 'different_person')}>Different person</button>
            </>
          ) : (
            <span className="muted">{k.link_status === 'same_person' ? 'marked same person' : 'marked different person'}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Every call is its own entry; changed outcomes show the earlier ones struck through. */
export function CallHistory({ calls, onChange }: { calls: Call[]; onChange: () => void }) {
  const { meta, toast, bumpStats } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [due, setDue] = useState('');
  if (!calls.length) return <p className="muted">No calls yet.</p>;
  const save = async (c: Call) => {
    try {
      await api.post(`/calls/${c.id}/outcomes`, {
        outcome_code: code,
        expected_current_id: c.current_outcome?.id ?? null,
        callback_due_at: due ? new Date(due).toISOString() : null,
      });
      setEditing(null);
      toast('Outcome changed. The earlier one is kept in history.');
      bumpStats();
      onChange();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const remove = async (c: Call) => {
    if (!window.confirm('Undo this call? It stays in the history, marked as undone, and stops counting toward the lead and your numbers.')) return;
    try {
      const r = await api.post<{ calendar_unitrust_has_it?: boolean }>(`/calls/${c.id}/void`, { reason: 'undone from history' });
      if (r.calendar_unitrust_has_it) toast('Call undone. Unitrust had already booked the appointment: cancel it in Unitrust.', 'error');
      else toast('Call undone');
      bumpStats();
      onChange();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const needsTime = meta?.outcome_codes.find((o) => o.code === code)?.requires_callback_time;
  return (
    <ul className="history">
      {calls.map((c) => (
        <li key={c.id} className={c.voided_at ? 'voided' : ''}>
          <div className="when">
            {c.time_known === 0 ? <>On or before {new Date(c.requested_at).toLocaleDateString()}</> : fmtDateTime(c.requested_at)}{' '}
            <span className="muted">{c.history_source === 'sheet' ? 'from your spreadsheet, exact time unknown' : c.channel === 'manual_log' ? 'logged' : c.state}</span>
          </div>
          <div className="meta">
            to {fmtPhone(c.to_e164)}{c.from_e164 && <> · from {c.from_label ?? ''} {fmtPhone(c.from_e164)}</>}
            {c.talk_seconds != null && <> · {Math.round(c.talk_seconds / 60)} min</>}
            {c.dial_count > 1 && <> · <b>{c.dial_count} dials</b></>}
          </div>
          {c.voided_at && <div className="muted">Undone {fmtDateTime(c.voided_at)}. Not counted anywhere.</div>}
          <div>
            {c.outcomes.map((o) => (
              <div key={o.id} className={o.superseded ? 'superseded' : ''}>
                {o.label}
                {o.callback_due_at && <> · call back {fmtDateTime(o.callback_due_at)}</>}
                {!o.callback_due_at && o.outcome_code === 'callback' && !o.superseded && <span className="warn"> · needs a time</span>}
              </div>
            ))}
          </div>
          {c.voided_at ? null : editing === c.id ? (
            <div className="row" style={{ marginTop: 4 }}>
              <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="New outcome">
                {meta?.outcome_codes.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </select>
              {needsTime ? <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Callback time" /> : null}
              <button className="btn small primary" onClick={() => save(c)}>Save</button>
              <button className="btn small" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          ) : (
            <div className="row">
              <button className="btn small" onClick={() => { setEditing(c.id); setCode(c.current_outcome?.outcome_code ?? 'no_answer'); setDue(''); }}>
                Change outcome
              </button>
              {c.channel === 'manual_log' && (
                <button className="btn small" onClick={() => remove(c)} title="Logged by mistake? It stays in history but stops counting.">Undo call</button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Notes({ d, onChange }: { d: LeadDetail; onChange: () => void }) {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const add = async () => {
    if (!text.trim()) return;
    try {
      await api.post(`/leads/${d.lead.id}/notes`, { body: text });
      setText('');
      onChange();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div>
      <textarea
        id="note-input"
        placeholder="Add a note (Ctrl+Enter to save)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void add();
          }
        }}
      />
      <button className="btn small" onClick={add} disabled={!text.trim()}>Add note</button>
      <ul className="history notes">
        {d.notes.map((n) => (
          <li key={n.id}>
            <div className="meta">{fmtDateTime(n.created_at)}</div>
            {n.body}
          </li>
        ))}
      </ul>
    </div>
  );
}
