import { useState } from 'react';
import { api, fmtDateTime, fmtMoney, fmtPhone, fullName, localTime, type LeadDetail, type Call } from '../api';
import { useApp } from '../App';

const STATUS_LABEL: Record<string, string> = {
  new: 'New', retry: 'Retry', callback: 'Callback', appointment_set: 'Appointment', invalid: 'Invalid number', dead: 'Dead lead',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** Header + key facts used on the calling screen and the lead modal. */
export function LeadSummary({ d, onCopied }: { d: LeadDetail; onCopied?: () => void }) {
  const l = d.lead;
  const { toast } = useApp();
  const copy = async () => {
    if (!l.phone_e164) return;
    try {
      await navigator.clipboard.writeText(l.phone_e164.replace(/^\+1/, ''));
      toast('Phone number copied');
      onCopied?.();
    } catch {
      toast('Could not copy; select the number instead', 'error');
    }
  };
  const health = [
    ['Heart attack', l.health_heart_raw], ['Stroke', l.health_stroke_raw], ['Cancer', l.health_cancer_raw], ['Diabetes', l.health_diabetes_raw],
  ].filter(([, v]) => v);
  const warnings: string[] = d.import_row?.warnings_json ? JSON.parse(d.import_row.warnings_json) : [];
  return (
    <>
      <div className="lead-head">
        <div>
          <h2><span className="lead-name">{fullName(l)}</span> {d.state && <StatusBadge status={d.state.status} />}</h2>
          <div className="where">
            {[l.city, l.state].filter(Boolean).join(', ')}
            {l.time_zone && <> · <b>{localTime(l.time_zone)}</b> local</>}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="phone-big">{l.phone_e164 ? fmtPhone(l.phone_e164) : <span className="error">no valid phone</span>}</div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {l.phone_e164 && <button className="btn small" onClick={copy} title="Copy number (C)">Copy number <kbd>C</kbd></button>}
            {l.phone2_e164 && <span className="muted">alt {fmtPhone(l.phone2_e164)}</span>}
          </div>
        </div>
      </div>
      <div className="facts">
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
        {Object.entries(l.extra ?? {}).map(([k, v]) => <Fact key={k} label={k} v={v} />)}
      </div>
      {d.appointments.length > 0 && (
        <div className="card" style={{ padding: 10 }}>
          {d.appointments.map((a) => (
            <div key={a.id}>
              Appointment <b>{fmtDateTime(a.scheduled_for)}</b>
              {a.from_e164 && <> · set from <b>{a.from_label ?? fmtPhone(a.from_e164)}</b> ({fmtPhone(a.from_e164)})</>}
              <span className="muted"> · {a.internal_status}. Official status lives on the IMO site.</span>
            </div>
          ))}
        </div>
      )}
      {d.linked.length > 0 && <LinkedLeads d={d} />}
      {warnings.length > 0 && <p className="help">Import notes: {warnings.join('; ')}</p>}
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
  const needsTime = meta?.outcome_codes.find((o) => o.code === code)?.requires_callback_time;
  return (
    <ul className="history">
      {calls.map((c) => (
        <li key={c.id}>
          <div className="when">{fmtDateTime(c.requested_at)} <span className="muted">{c.channel === 'manual_log' ? 'logged' : c.state}</span></div>
          <div className="meta">
            to {fmtPhone(c.to_e164)}{c.from_e164 && <> · from {c.from_label ?? ''} {fmtPhone(c.from_e164)}</>}
            {c.talk_seconds != null && <> · {Math.round(c.talk_seconds / 60)} min</>}
          </div>
          <div>
            {c.outcomes.map((o) => (
              <div key={o.id} className={o.superseded ? 'superseded' : ''}>
                {o.label}
                {o.callback_due_at && <> · call back {fmtDateTime(o.callback_due_at)}</>}
              </div>
            ))}
          </div>
          {editing === c.id ? (
            <div className="row" style={{ marginTop: 4 }}>
              <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="New outcome">
                {meta?.outcome_codes.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </select>
              {needsTime ? <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Callback time" /> : null}
              <button className="btn small primary" onClick={() => save(c)}>Save</button>
              <button className="btn small" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          ) : (
            <button className="btn small" onClick={() => { setEditing(c.id); setCode(c.current_outcome?.outcome_code ?? 'no_answer'); setDue(''); }}>
              Change outcome
            </button>
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
