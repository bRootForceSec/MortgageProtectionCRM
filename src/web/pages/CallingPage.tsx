import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, fmtPhone, fmtRelative, newKey, toLocalInput, type LeadDetail, type QueueResponse, type QueueItem } from '../api';
import { useApp } from '../App';
import { LeadSummary, CallHistory, Notes } from '../components/LeadView';

const BUCKETS: { key: QueueItem['bucket'] | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'callback_due', label: 'Callbacks due' },
  { key: 'appointment_passed', label: 'Past appointments' },
  { key: 'new', label: 'New' },
  { key: 'retry', label: 'Retry' },
];

const SELECTED_KEY = 'mpcrm.selectedLead';
const LAST_NUMBER_KEY = 'mpcrm.lastNumber';

function store(k: string, v?: string | null) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: selection just won't persist */
  }
  return null;
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function CallingPage() {
  const { toast } = useApp();
  const [bucket, setBucket] = useState<QueueItem['bucket'] | 'all'>('all');
  const [search, setSearch] = useState('');
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(store(SELECTED_KEY));
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadQueue = useCallback(async () => {
    try {
      const q = await api.get<QueueResponse>('/queue', { bucket: bucket === 'all' ? undefined : bucket, search });
      setQueue(q);
      return q;
    } catch (e: any) {
      toast(e.message, 'error');
      return null;
    }
  }, [bucket, search, toast]);

  const loadDetail = useCallback(async (id: string | null) => {
    if (!id) return setDetail(null);
    try {
      setDetail(await api.get<LeadDetail>(`/leads/${id}`));
    } catch {
      setDetail(null);
      setSelected(null);
      store(SELECTED_KEY, null);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void loadQueue(), search ? 200 : 0);
    return () => clearTimeout(t);
  }, [loadQueue, search]);

  useEffect(() => {
    // Keep progress on refresh: reselect the stored lead, else the top of the queue.
    if (!selected && queue?.items[0]) select(queue.items[0].lead_id);
  }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => void loadDetail(selected), [selected, loadDetail]);

  const select = (id: string | null) => {
    setSelected(id);
    store(SELECTED_KEY, id);
  };

  const next = useCallback(async () => {
    const q = await loadQueue();
    const n = q?.items.find((i) => i.lead_id !== selected);
    if (n) select(n.lead_id);
    else toast('Queue is empty');
  }, [loadQueue, selected, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const skip = useCallback(async () => {
    if (!selected) return;
    await api.post(`/leads/${selected}/actions`, { action: 'skip' });
    toast('Skipped');
    await next();
  }, [selected, next, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); void next(); }
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); void skip(); }
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); document.getElementById('note-input')?.focus(); }
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); (document.querySelector('[title="Copy number (C)"]') as HTMLButtonElement | null)?.click(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, skip]);

  const refresh = async () => {
    await Promise.all([loadQueue(), loadDetail(selected)]);
  };

  return (
    <div className="calling">
      <section className="panel" aria-label="Queue">
        <header>
          <input
            ref={searchRef}
            placeholder="Search name or phone  ( / )"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setSearch(''), (e.target as HTMLInputElement).blur())}
            style={{ width: '100%' }}
          />
          <div className="tabs" title="Order: due callbacks, past appointments, new leads (newest batch first), then retries 4 h after the last attempt. Skipped leads drop to the end for today.">
            {BUCKETS.map((b) => (
              <button key={b.key} className={bucket === b.key ? 'active' : ''} onClick={() => setBucket(b.key)}>
                {b.label}
                {b.key !== 'all' && queue ? ` ${queue.counts[b.key]}` : ''}
              </button>
            ))}
          </div>
        </header>
        <div className="body">
          {!queue ? null : queue.items.length === 0 ? (
            <div className="empty">
              Nothing to call right now.
              {queue.waiting_later > 0 && <div>{queue.waiting_later} lead(s) are waiting for a later callback or retry time.</div>}
            </div>
          ) : (
            <ul className="queue-list">
              {queue.items.map((i) => (
                <li key={i.lead_id} className={`${selected === i.lead_id ? 'selected' : ''} ${i.skipped_today ? 'skipped' : ''}`} onClick={() => select(i.lead_id)}>
                  <span className="name">{i.name}</span>
                  <span className={`badge ${i.bucket}`}>{i.bucket === 'callback_due' ? 'callback' : i.bucket === 'appointment_passed' ? 'appt passed' : i.bucket}</span>
                  <span className="sub">
                    {fmtPhone(i.phone_e164)} · {i.state ?? '?'} · {i.attempts_total ? `${i.attempts_total} attempt${i.attempts_total > 1 ? 's' : ''}, last ${fmtRelative(i.last_call_at)}` : 'never called'}
                    {i.skipped_today && ' · skipped'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <header style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
          <span className="help"><kbd>N</kbd> next <kbd>S</kbd> skip <kbd>/</kbd> search <kbd>C</kbd> copy number <kbd>A</kbd> note</span>
        </header>
      </section>

      <section className="panel" aria-label="Current lead">
        <div className="body">
          {!detail ? (
            <div className="empty">Select a lead from the queue, or import leads first.</div>
          ) : (
            <>
              <LeadSummary d={detail} />
              <LogCall key={detail.lead.id} d={detail} onSaved={refresh} />
            </>
          )}
        </div>
      </section>

      <section className="panel" aria-label="History">
        <header><h3>Calls</h3></header>
        <div className="body">
          {detail && <CallHistory calls={detail.calls} onChange={refresh} />}
          <h3 style={{ marginTop: 16 }}>Notes</h3>
          {detail && <Notes d={detail} onChange={() => loadDetail(selected)} />}
        </div>
      </section>
    </div>
  );
}

/**
 * Log a call made on another phone (Sideline) with one keypress plus Enter.
 * Phase 2 replaces "log" with "call" but keeps this outcome panel.
 */
function LogCall({ d, onSaved }: { d: LeadDetail; onSaved: () => Promise<void> }) {
  const { meta, toast, bumpStats } = useApp();
  const activeNumbers = useMemo(() => (meta?.numbers ?? []).filter((n) => n.status !== 'retired'), [meta]);
  const defaultNumber = useMemo(() => {
    const pref = d.state?.preferred_number_id;
    if (pref && activeNumbers.some((n) => n.id === pref)) return { id: pref, why: d.appointments.length ? 'number this appointment was set from' : 'number last used with this lead' };
    const last = store(LAST_NUMBER_KEY);
    if (last && activeNumbers.some((n) => n.id === last)) return { id: last, why: 'your last used number' };
    return { id: activeNumbers[0]?.id ?? '', why: activeNumbers[0] ? 'first active number' : '' };
  }, [d, activeNumbers]);

  const [numberId, setNumberId] = useState(defaultNumber.id);
  const [code, setCode] = useState<string | null>(null);
  const [when, setWhen] = useState('');
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState(newKey());
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const whenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!numberId && defaultNumber.id) setNumberId(defaultNumber.id);
  }, [defaultNumber.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const outcome = meta?.outcome_codes.find((o) => o.code === code) ?? null;
  const needsWhen = outcome?.requires_callback_time || outcome?.code === 'appointment';
  const changed = numberId !== defaultNumber.id;

  const choose = useCallback((c: string) => {
    setCode(c);
    const o = meta?.outcome_codes.find((x) => x.code === c);
    if (o?.requires_callback_time || c === 'appointment') {
      const t = new Date(Date.now() + 86_400_000);
      t.setMinutes(0, 0, 0);
      setWhen((w) => w || toLocalInput(t));
      setTimeout(() => whenRef.current?.focus(), 0);
    }
  }, [meta]);

  const save = useCallback(async () => {
    if (!code || saving) return;
    if (code === 'dnc_request' && !window.confirm('Move this lead to the dead pile? It will leave the queue.')) return;
    if (needsWhen && !when) {
      toast(code === 'appointment' ? 'Enter the appointment time' : 'Enter when to call back', 'error');
      whenRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const iso = when ? new Date(when).toISOString() : null;
      await api.post(`/leads/${d.lead.id}/calls`, {
        idempotency_key: key,
        from_number_id: numberId || null,
        outcome_code: code,
        callback_due_at: outcome?.requires_callback_time ? iso : null,
        appointment_at: code === 'appointment' ? iso : null,
        talk_seconds: minutes ? Number(minutes) * 60 : null,
        note: note || null,
      });
      if (numberId) store(LAST_NUMBER_KEY, numberId);
      setLastSaved(outcome?.label ?? code);
      setCode(null);
      setWhen('');
      setMinutes('');
      setNote('');
      setKey(newKey());
      toast(`Saved: ${outcome?.label ?? code}. Press N for the next lead.`);
      bumpStats();
      await onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }, [code, saving, needsWhen, when, key, numberId, outcome, minutes, note, d.lead.id, toast, bumpStats, onSaved]);

  // Layout effect: the hotkeys are live as soon as the lead is on screen, so a fast keypress isn't lost.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && code && (!isTyping(e) || e.ctrlKey || e.metaKey || ['when-input', 'log-note', 'log-minutes'].includes((e.target as HTMLElement).id))) {
        e.preventDefault();
        void save();
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') return setCode(null);
      const o = meta?.outcome_codes.find((x) => x.hotkey && x.hotkey === e.key.toLowerCase());
      if (o) {
        e.preventDefault();
        choose(o.code);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [meta, code, save, choose]);

  if (!d.lead.phone_e164) return <p className="error">This lead has no valid phone number.</p>;
  if (d.state?.status === 'dead') return <RestoreBox d={d} onSaved={onSaved} label="This lead is in the dead pile." />;

  return (
    <div className="log-box">
      <div className="row">
        <label className="field">
          <span>Caller ID used {defaultNumber.why && !changed && <em>({defaultNumber.why})</em>}</span>
          <select value={numberId} onChange={(e) => setNumberId(e.target.value)} style={changed ? { borderColor: 'var(--warn)' } : undefined}>
            <option value="">Not recorded</option>
            {activeNumbers.map((n) => (
              <option key={n.id} value={n.id}>{n.label ? `${n.label} · ` : ''}{fmtPhone(n.e164)}{n.reputation_status === 'flagged' ? ' (flagged)' : ''}</option>
            ))}
          </select>
        </label>
        {changed && <span className="warn">Different from the suggested number.</span>}
        {activeNumbers.length === 0 && <span className="help">Add your numbers on the Numbers page to record which one you used.</span>}
      </div>
      <div className="outcomes" role="group" aria-label="Outcome">
        {meta?.outcome_codes.map((o) => (
          <button key={o.code} className={`${code === o.code ? 'active' : ''} ${o.marks_dead ? 'dead' : ''}`} onClick={() => choose(o.code)}>
            {o.hotkey && <kbd>{o.hotkey.toUpperCase()}</kbd>}{o.label}
          </button>
        ))}
      </div>
      {code && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          {needsWhen && (
            <label className="field">
              <span>{code === 'appointment' ? 'Appointment time' : 'Call back at'} (your time)</span>
              <input id="when-input" ref={whenRef} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span>Talk minutes (optional)</span>
            <input id="log-minutes" type="number" min={0} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 90 }} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            <span>Note (optional)</span>
            <input id="log-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn primary" onClick={save} disabled={saving}>Save <kbd>Enter</kbd></button>
          <button className="btn" onClick={() => setCode(null)}>Cancel <kbd>Esc</kbd></button>
        </div>
      )}
      {!code && lastSaved && <p className="ok">Saved: {lastSaved}. Press <kbd>N</kbd> for the next lead.</p>}
      {!code && !lastSaved && <p className="help">After the call, press the outcome key, then Enter.</p>}
      {d.state?.status === 'invalid' && <RestoreBox d={d} onSaved={onSaved} label="Marked as an invalid number or wrong person." />}
    </div>
  );
}

function RestoreBox({ d, onSaved, label }: { d: LeadDetail; onSaved: () => Promise<void>; label: string }) {
  const { toast } = useApp();
  const restore = async () => {
    await api.post(`/leads/${d.lead.id}/actions`, { action: 'restore', reason: 'restored from calling screen' });
    toast('Lead restored to the queue');
    await onSaved();
  };
  return (
    <div className="card" style={{ marginTop: 10 }}>
      {label} <button className="btn small" onClick={restore}>Restore to queue</button>
    </div>
  );
}
