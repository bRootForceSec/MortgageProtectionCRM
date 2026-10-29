import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, personAge, fmtMoney, fmtPhone, fmtRelative, type LeadDetail, type RecentOutcome } from '../api';
import { useApp } from '../App';
import { StatusBadge } from '../components/LeadDetails';
import { fillScript } from '../shortcuts';
import type { Saved } from './LogCall';
import type { CallMode } from '../../shared/appointments';

// The smaller parts of the Calling screen: the incoming-call lookup, the First call | Appointment switch, the undo
// bar, the script and the recent outcomes.

/** How long a saved call can be undone. */
export const UNDO_MS = 10_000;

interface LookupRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_e164: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  status: string;
  attempts_total: number;
  last_call_at: string | null;
}

/**
 * Incoming call: type part of their number (or a name) and open the lead, any status, without touching the list.
 * Enter opens the top match; the arrow keys pick another.
 */
export function CallerLookup({ inputRef, hotkey, onOpen }: { inputRef: RefObject<HTMLInputElement | null>; hotkey: string; onOpen: (id: string) => void }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<LookupRow[] | null>(null);
  const [hi, setHi] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const s = q.trim();
    const digits = s.replace(/\D/g, '');
    // Four digits are enough for a number; two letters for a name.
    if (digits.length < 4 && s.replace(/[^a-z]/gi, '').length < 2) {
      setRows(null);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = (await api.get<{ rows: LookupRow[] }>('/leads', { search: digits.length >= 4 ? digits : s })).rows;
        if (n === seq.current) {
          setRows(r.slice(0, 8));
          setHi(0);
        }
      } catch (e: any) {
        toast(e.message, 'error');
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q, toast]);

  const open = (r: LookupRow | undefined) => {
    if (!r) return;
    onOpen(r.id);
    setQ('');
    setRows(null);
    inputRef.current?.blur();
  };

  return (
    <div className="lookup">
      <input
        ref={inputRef}
        type="search"
        placeholder={`Incoming call? Type their number to pull them up  ( ${hotkey} )`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setQ(''); setRows(null); (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'Enter') { e.preventDefault(); open(rows?.[hi]); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min((rows?.length ?? 1) - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
        }}
        onBlur={() => setTimeout(() => setRows(null), 150)}
        aria-label="Look up a caller by phone number"
        autoComplete="off"
      />
      {rows && (
        <ul className="lookup-results" role="listbox">
          {rows.length === 0 && <li className="muted">No lead has that number.</li>}
          {rows.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''}
              onMouseDown={(e) => { e.preventDefault(); open(r); }} onMouseEnter={() => setHi(i)}>
              <b>{[r.first_name, r.last_name].filter(Boolean).join(' ') || 'No name'}</b> <StatusBadge status={r.status} />
              <span className="sub">
                {fmtPhone(r.phone_e164)} · {r.county ? `${r.county} Co.` : r.city ?? r.state ?? '?'} · {r.attempts_total ? `${r.attempts_total} attempt${r.attempts_total > 1 ? 's' : ''}, last ${fmtRelative(r.last_call_at)}` : 'never called'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** First call | Appointment: which outcomes the lead section offers. */
export function ModeSwitch({ mode, onChange, hotkey }: { mode: CallMode; onChange: (m: CallMode) => void; hotkey: string }) {
  return (
    <div className="mode-switch" role="tablist" aria-label="Kind of call" title={hotkey ? `Press ${hotkey} to switch` : undefined}>
      {([['first_call', 'First call'], ['appointment', 'Appointment']] as const).map(([m, label]) => (
        <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => onChange(m)}>{label}</button>
      ))}
      {hotkey && <kbd>{hotkey}</kbd>}
    </div>
  );
}

export function UndoBar({ saved, undoKey, onUndo, onExpire }: { saved: Saved; undoKey: string; onUndo: () => void; onExpire: () => void }) {
  const [left, setLeft] = useState(Math.ceil((UNDO_MS - (Date.now() - saved.at)) / 1000));
  useEffect(() => {
    const t = setInterval(() => {
      const l = Math.ceil((UNDO_MS - (Date.now() - saved.at)) / 1000);
      if (l <= 0) onExpire();
      else setLeft(l);
    }, 250);
    return () => clearInterval(t);
  }, [saved, onExpire]);
  return (
    <div className="undo-bar" role="status">
      Saved for {saved.name}: <b>{saved.label}</b>{saved.dials > 1 ? ` · ${saved.dials} dials` : ''}
      <button className="btn small" onClick={onUndo}>Undo <kbd>{undoKey}</kbd></button>
      <span className="muted">{left}s</span>
    </div>
  );
}

/** Your opener and voicemail with this lead's details filled in. */
export function ScriptPanel({ d }: { d: LeadDetail }) {
  const { calling, go } = useApp();
  const sc = calling?.settings.scripts;
  const l = d.lead;
  const values = {
    first_name: l.first_name, last_name: l.last_name, full_name: [l.first_name, l.last_name].filter(Boolean).join(' '),
    lender: l.lender, loan_amount: l.loan_amount_cents != null ? fmtMoney(l.loan_amount_cents) : l.loan_amount_raw,
    address: l.address_line, city: l.city, state: l.state, county: l.county, age: personAge(l) != null ? String(personAge(l)) : null,
    agent_name: sc?.agent_name,
  };
  if (!sc?.opener && !sc?.voicemail) {
    return (
      <div className="card script">
        No script yet. <button className="btn small" onClick={() => go('settings')}>Write one in Settings</button>
      </div>
    );
  }
  return (
    <div className="card script">
      {sc.opener && (<><b>Opener</b><p>{fillScript(sc.opener, values)}</p></>)}
      {sc.voicemail && (<><b>Voicemail</b><p>{fillScript(sc.voicemail, values)}</p></>)}
    </div>
  );
}

/** The lead's next working number after the one being called, if it has one. */
export function otherNumber(d: LeadDetail): string | null {
  const blocked: string[] = d.state?.blocked_phones_json ? JSON.parse(d.state.blocked_phones_json) : [];
  const now = d.state?.active_phone_e164 ?? d.lead.phone_e164;
  return [d.lead.phone_e164, ...d.lead.other_phones.map((p) => p.e164)].find((p) => p && p !== now && !blocked.includes(p)) ?? null;
}

/** The last outcomes you set, newest first: click one to open that lead and fix it, even after clearing the list. */
export function Recent({ items, onOpen }: { items: RecentOutcome[]; onOpen: (id: string) => void }) {
  return (
    <details className="recent" open>
      <summary>Recent outcomes</summary>
      <ul>
        {items.map((r) => (
          <li key={r.call_id}>
            <button className="link" onClick={() => onOpen(r.lead_id)} title="Open this lead to check or change the outcome">
              {r.name || '(no name)'}
            </button>
            <span className="muted"> · {r.label} · {fmtRelative(r.entered_at)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
