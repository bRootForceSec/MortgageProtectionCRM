import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtDob, fmtDuration, fmtMoney, fmtPhone, fullName, localTime, personAge, type LeadDetail, type Call } from '../api';
import { useApp } from '../App';
import { APPT_RESULT_LABEL, type ApptResult } from '../../shared/appointments';
import { outcomeDef } from '../../shared/outcomes';

const STATUS_LABEL: Record<string, string> = {
  new: 'New', retry: 'Tried', callback: 'Callback', appointment_set: 'Appointment set', invalid: 'Bad number', dead: 'Dead lead',
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

/** How the lead's latest appointment went in Unitrust (color on its calendar), when the extension has seen one. */
export function ApptBadge({ result }: { result: string | null | undefined }) {
  if (!result || !(result in APPT_RESULT_LABEL)) return null;
  return <span className={`badge appt appt-${result}`} title="How the latest appointment went (logged here, or from the Unitrust calendar)">{APPT_RESULT_LABEL[result as ApptResult]}</span>;
}

/** "They called me back": flips the mark on a lead and says so. Returns the new value. */
export async function toggleCalledBack(d: LeadDetail, toast: (m: string, kind?: 'error') => void): Promise<string | null> {
  try {
    const r = await api.post<{ called_back_at: string | null }>(`/leads/${d.lead.id}/called-back`, { on: !d.called_back_at });
    toast(r.called_back_at ? `${fullName(d.lead)} called you back ✓` : `Took off "called back" for ${fullName(d.lead)}`);
    return r.called_back_at;
  } catch (e: any) {
    toast(e.message, 'error');
    return d.called_back_at;
  }
}

/** Header + key facts used on the calling screen and the lead modal. */
export function LeadSummary({
  d, onDial, dialLabel = 'Copy number', dialKey, altKey, onEdit, editKey, onCalledBack, calledBackKey,
}: {
  d: LeadDetail;
  /** On the Calling screen: dial (or copy, or show a QR code, per Settings) and start the attempt. */
  onDial?: (e164: string) => void;
  dialLabel?: string;
  dialKey?: string;
  /** Key that dials the other number. */
  altKey?: string;
  onEdit?: () => void;
  editKey?: string;
  /** After the "called me back" mark changes, so the page can reload the lead. */
  onCalledBack?: (at: string | null) => void;
  calledBackKey?: string;
}) {
  const l = d.lead;
  const { toast } = useApp();
  // Shown ticked at once; the app's answer follows.
  const [backAt, setBackAt] = useState(d.called_back_at);
  useEffect(() => setBackAt(d.called_back_at), [d.lead.id, d.called_back_at]);
  const flipBack = async () => {
    setBackAt(backAt ? null : new Date().toISOString());
    const at = await toggleCalledBack({ ...d, called_back_at: backAt }, toast);
    setBackAt(at);
    onCalledBack?.(at);
  };
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
  // The big number is the one being called: the main number, unless it was ruled out and another one wasn't.
  const blocked: string[] = d.state?.blocked_phones_json ? JSON.parse(d.state.blocked_phones_json) : [];
  const main = d.state?.active_phone_e164 ?? l.phone_e164;
  const others = ([
    ...(l.phone_e164 ? [['Main', l.phone_e164, l.phone_raw]] : []),
    ...d.lead.other_phones.map((p) => [p.label || 'Other', p.e164, p.raw]),
  ] as [string, string | null, string | null][]).filter(([, e, r]) => (e || r) && !(e && e === main));
  const age = personAge(l);
  const firstOther = others.find(([, e]) => e && !blocked.includes(e))?.[1] ?? null;
  return (
    <>
      {passphrase && <div className="passphrase">Passphrase: <b>{passphrase}</b></div>}
      <div className="lead-head">
        <div>
          <h2>
            <span className="lead-name">{fullName(l)}</span> {d.state && <StatusBadge status={d.state.status} />}{d.state && <ApptBadge result={d.state.appt_result} />}
            {onEdit && <button className="btn small" onClick={onEdit} title="Edit this lead's details">Edit {editKey && <kbd>{editKey}</kbd>}</button>}
            <label className={`called-back ${backAt ? 'on' : ''}`} title={backAt ? `Marked ${fmtDateTime(backAt)}` : 'Tick when this lead calls you back'}>
              <input type="checkbox" checked={!!backAt} onChange={() => void flipBack()} />
              Called me back {calledBackKey && <kbd>{calledBackKey}</kbd>}
            </label>
          </h2>
          <div className="where">
            {age != null && <><b>Age {age}</b> · </>}
            {[l.city, l.state].filter(Boolean).join(', ')}
            {l.county && <> · <b>{l.county} County</b></>}
            {l.time_zone && <> · <b>{localTime(l.time_zone)}</b> local</>}
          </div>
        </div>
        <div className="phones">
          <div className="phone-big">{main ? fmtPhone(main) : <span className="error">no valid phone</span>}</div>
          {main && <button className="btn small" onClick={() => copy(main)}>{dialLabel} {dialKey && <kbd>{dialKey}</kbd>}</button>}
          {others.map(([label, e164, raw], i) => {
            const bad = !!e164 && blocked.includes(e164);
            return (
              <div key={i} className="row" style={{ justifyContent: 'flex-end' }}>
                <span className="muted">{label}</span>
                <span className="alt" style={bad ? { textDecoration: 'line-through' } : undefined}>{e164 ? fmtPhone(e164) : raw}</span>
                {bad && <span className="warn">bad number</span>}
                {e164 && (
                  <button className="btn small" onClick={() => copy(e164)} title={`${dialLabel}: ${label.toLowerCase()} number`}>
                    {onDial ? dialLabel.replace(' number', '') : 'Copy'} {altKey && e164 === firstOther && <kbd>{altKey}</kbd>}
                  </button>
                )}
              </div>
            );
          })}
          {d.state?.block_reason && <div className="help warn">{d.state.block_reason}</div>}
        </div>
      </div>
      <div className="facts">
        <Fact label="County" v={l.county ? `${l.county}, ${l.state ?? ''}${l.county_source ? ` (${COUNTY_SOURCE[l.county_source] ?? l.county_source})` : ''}` : null} />
        <Fact label="Lead type" v={l.lead_type ? `${l.lead_type}${l.price_cents != null ? ` · ${fmtMoney(l.price_cents)}` : ''}${pageType ? ` · ${pageType}` : ''}` : pageType} />
        <Fact label="Called in" v={l.callin_at ? `${fmtDateTime(l.callin_at)} · ${leadAge(l.callin_at)}` : l.callin_raw} />
        <Fact label="Lead ID" v={l.source_lead_id} />
        <Fact label="Age" v={l.dob ? `${age} (from date of birth)` : l.age ?? l.age_raw} />
        <Fact label="Date of birth" v={l.dob ? fmtDob(l.dob) : l.dob_raw} />
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
      {d.linked.length > 0 && <LinkedLeads d={d} />}
      {(warnings.length > 0 || importNotes) && <p className="help">Import notes: {[importNotes, ...warnings].filter(Boolean).join(' ')}</p>}
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

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

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
      await api.post(`/calls/${c.id}/void`, { reason: 'undone from history' });
      toast('Call undone');
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
            {c.lead_seconds != null && <> · {fmtDuration(c.lead_seconds)} on lead</>}
          </div>
          {c.voided_at && <div className="muted">Undone {fmtDateTime(c.voided_at)}. Not counted anywhere.</div>}
          <div>
            {c.outcomes.map((o) => (
              <div key={o.id} className={o.superseded ? 'superseded' : ''}>
                {o.label}
                {!!o.do_not_call && <span className="warn"> · do not call</span>}
                {c.outcomes.length > 1 && <span className="muted"> · set {fmtDateTime(o.entered_at)}</span>}
                {o.callback_due_at && <> · call back {o.callback_any_time ? `${fmtDay(o.callback_due_at)}, any time` : fmtDateTime(o.callback_due_at)}</>}
                {!o.callback_due_at && outcomeDef(o.outcome_code)?.callback && !o.superseded && <span className="warn"> · needs a time</span>}
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
