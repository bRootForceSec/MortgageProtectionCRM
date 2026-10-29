import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { describeCallback, differentZone, readCallback } from '../when';
import { api, fmtPhone, newKey, type LeadDetail } from '../api';
import { useApp } from '../App';
import { isTyping, keyLabel, normKey, type KeyMap } from '../shortcuts';
import { getStored, setStored } from '../storage';
import type { CallMode } from '../../shared/appointments';
import { savesInstantly } from '../../shared/outcomes';

// The "log the call" form on the Calling screen: number used, outcome, callback time, minutes and note.
// It has two sides with the same layout: First call (no answer, appt set, ...) and Appointment (no show, prezi, sale, ...).

const LAST_NUMBER_KEY = 'mpcrm.lastNumber';

/** One attempt on the current lead: how many dials, when the timer started, which number was dialed. */
export interface Attempt {
  dials: number;
  timerStart: number | null;
  to: string | null;
  /** When this lead came on screen, for the time spent on it. */
  shownAt: number;
}

/** What you had entered, put back after an undo. */
export interface FormValues {
  code: string | null;
  /** Callback picker: the day and the optional time, as typed. */
  day: string;
  time: string;
  minutes: string;
  note: string;
  numberId: string | null;
  /** The "Do not call" tick. */
  doNotCall?: boolean;
}

export interface Saved {
  callId: string;
  leadId: string;
  name: string;
  label: string;
  dials: number;
  at: number;
  /** The lead's time zone, so an undone callback comes back in their time. */
  tz: string | null;
}

function Timer({ start, onReset }: { start: number; onReset: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - start) / 1000));
  return (
    <span className="timer" title="Started when you dialed. Fills talk minutes when someone picked up.">
      ⏱ {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
      <button className="btn small" onClick={onReset} aria-label="Reset timer">Reset</button>
    </span>
  );
}

/**
 * Log a call made on another phone (Sideline) with one keypress plus Enter.
 * Phase 2 replaces "log" with "call" but keeps this outcome panel.
 */
export function LogCall({
  d, mode, attempt, setDials, resetTimer, restore, active, onSaved, onRefresh,
}: {
  d: LeadDetail;
  /** Which outcomes to offer: the First call side or the Appointment side. */
  mode: CallMode;
  attempt: Attempt;
  setDials: (n: number) => void;
  resetTimer: () => void;
  restore: FormValues | null;
  /** False for a moment after you move on, until the next lead is on screen: keys wait. */
  active: boolean;
  onSaved: (s: Saved) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const { meta, toast, keys, calling } = useApp();
  const activeNumbers = useMemo(() => (meta?.numbers ?? []).filter((n) => n.status !== 'retired'), [meta]);
  const defaultNumber = useMemo(() => {
    const pref = d.state?.preferred_number_id;
    if (pref && activeNumbers.some((n) => n.id === pref)) {
      return { id: pref, why: d.state?.status === 'appointment_set' ? 'number this appointment was set from' : 'number last used with this lead', known: true };
    }
    const last = getStored(LAST_NUMBER_KEY);
    if (last && activeNumbers.some((n) => n.id === last)) return { id: last, why: 'your last used number', known: false };
    return { id: activeNumbers[0]?.id ?? '', why: activeNumbers[0] ? 'first active number' : '', known: false };
  }, [d, activeNumbers]);

  const [numberId, setNumberId] = useState(restore?.numberId ?? defaultNumber.id);
  const [code, setCode] = useState<string | null>(restore?.code ?? null);
  const [day, setDay] = useState(restore?.day ?? '');
  const [time, setTime] = useState(restore?.time ?? '');
  const [minutes, setMinutes] = useState(restore?.minutes ?? '');
  const [note, setNote] = useState(restore?.note ?? '');
  const [doNotCall, setDoNotCall] = useState(!!restore?.doNotCall);
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState(newKey());
  const dayRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!numberId && defaultNumber.id) setNumberId(defaultNumber.id);
  }, [defaultNumber.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const outcomes = useMemo(() => (meta?.outcome_codes ?? []).filter((o) => (o.kind ?? 'first_call') === mode), [meta, mode]);
  const outcome = outcomes.find((o) => o.code === code) ?? null;
  const needsWhen = !!outcome?.requires_callback_time;
  const changed = numberId !== defaultNumber.id;

  const choose = useCallback((c: string) => {
    setCode(c);
    const o = meta?.outcome_codes.find((x) => x.code === c);
    if (o?.requires_callback_time) {
      setDay((v) => v || 'tomorrow');
      setTimeout(() => { dayRef.current?.focus(); dayRef.current?.select(); }, 0);
      return;
    }
    // No answer and Bad number need nothing more, so they save straight away (Undo still catches a wrong key).
    if (calling?.settings.instant_save !== false && o && savesInstantly(o)) void saveRef.current(c);
  }, [meta, calling]);

  // Talk time from the timer, only when someone picked up and you didn't type minutes yourself.
  const timerSeconds = (o: typeof outcome) =>
    attempt.timerStart && o?.counts_as_human_contact && calling?.settings.use_timer !== false
      ? Math.round((Date.now() - attempt.timerStart) / 1000)
      : null;

  const save = useCallback(async (codeNow: string | null = code) => {
    if (!codeNow || saving) return;
    const o = meta?.outcome_codes.find((x) => x.code === codeNow) ?? null;
    const cb = o?.requires_callback_time ? readCallback(day, time, new Date(), d.lead.time_zone) : null;
    if (cb && 'error' in cb) {
      toast(cb.error, 'error');
      dayRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const r = await api.post<{ call_id: string }>(`/leads/${d.lead.id}/calls`, {
        idempotency_key: key,
        from_number_id: numberId || null,
        to_e164: attempt.to,
        outcome_code: codeNow,
        callback_due_at: cb ? cb.at.toISOString() : null,
        callback_any_time: cb ? cb.anyTime : null,
        do_not_call: doNotCall,
        talk_seconds: minutes ? Number(minutes) * 60 : timerSeconds(o),
        dial_count: attempt.dials,
        lead_seconds: Math.round((Date.now() - attempt.shownAt) / 1000),
        note: note || null,
      });
      if (numberId) setStored(LAST_NUMBER_KEY, numberId);
      setCode(null);
      setDay('');
      setTime('');
      setMinutes('');
      setNote('');
      setDoNotCall(false);
      setKey(newKey());
      await onSaved({
        callId: r.call_id, leadId: d.lead.id, name: [d.lead.first_name, d.lead.last_name].filter(Boolean).join(' ') || 'this lead',
        label: `${o?.label ?? codeNow}${doNotCall ? ', do not call' : ''}`, dials: attempt.dials, at: Date.now(), tz: d.lead.time_zone ?? null,
      });
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }, [code, saving, meta, day, time, key, numberId, minutes, note, doNotCall, d.lead.id, toast, onSaved, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveRef = useRef(save);
  saveRef.current = save;

  // Layout effect: the hotkeys are live as soon as the lead is on screen, so a fast keypress isn't lost.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-back') || !active) return;
      if (e.key === 'Enter' && code && (!isTyping(e) || e.ctrlKey || e.metaKey || ['callback-day', 'callback-time', 'log-note', 'log-minutes'].includes((e.target as HTMLElement).id))) {
        e.preventDefault();
        void save();
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') return setCode(null);
      if (keys.actions.do_not_call?.includes(normKey(e.key))) {
        e.preventDefault();
        setDoNotCall((v) => !v);
        return;
      }
      // Action keys win over outcome keys (Settings warns about clashes).
      if (Object.values(keys.actions).some((ks) => ks.includes(normKey(e.key)))) return;
      const c = keys.outcomes[mode].get(normKey(e.key));
      if (c) {
        e.preventDefault();
        choose(c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys, code, save, choose, active, mode]);

  if (!d.lead.phone_e164 && !d.lead.other_phones.some((p) => p.e164)) return <p className="error">This lead has no valid phone number.</p>;
  if (d.state?.status === 'dead') return <RestoreBox d={d} onSaved={onRefresh} label={d.state.block_reason ? `${d.state.block_reason}.` : askedNotToCall(d) ? 'Asked not to be called again. This lead is in the dead pile.' : 'This lead is in the dead pile.'} />;

  const k = (a: keyof KeyMap['actions']) => keyLabel(keys.actions[a]?.[0] ?? '');
  return (
    <div className={`log-box${mode === 'appointment' ? ' appointment' : ''}`}>
      <div className="row">
        <div className="dial-counter" aria-label="Dials this attempt">
          <button className="btn small" onClick={() => setDials(attempt.dials - 1)} disabled={attempt.dials <= 1} aria-label="One less dial">− <kbd>{k('dials_down')}</kbd></button>
          <b>{attempt.dials}</b> dial{attempt.dials === 1 ? '' : 's'}
          <button className="btn small" onClick={() => setDials(attempt.dials + 1)} aria-label="One more dial">+ <kbd>{k('dials_up')}</kbd></button>
        </div>
        {attempt.timerStart && <Timer start={attempt.timerStart} onReset={resetTimer} />}
        {attempt.to && attempt.to !== d.lead.phone_e164 && <span className="warn">Dialing {fmtPhone(attempt.to)}</span>}
      </div>
      <div className="row">
        <label className="field">
          <span>Caller ID used {defaultNumber.why && !changed && <em>({defaultNumber.why})</em>}</span>
          <select value={numberId} onChange={(e) => setNumberId(e.target.value)} style={changed && defaultNumber.known ? { borderColor: 'var(--warn)' } : undefined}>
            <option value="">Not recorded</option>
            {activeNumbers.map((n) => (
              <option key={n.id} value={n.id}>{n.label ? `${n.label} · ` : ''}{fmtPhone(n.e164)}{n.reputation_status === 'flagged' ? ' (flagged)' : ''}</option>
            ))}
          </select>
        </label>
        {changed && defaultNumber.known && (() => {
          // Only worth a warning when this lead already knows you by another number.
          const n = activeNumbers.find((x) => x.id === defaultNumber.id);
          const shown = n ? `${n.label ? `${n.label}, ` : ''}${fmtPhone(n.e164)}` : 'another number';
          return (
            <span className="warn">
              {d.state?.status === 'appointment_set'
                ? `This lead's appointment was set from ${shown}. They may not pick up a number they don't know.`
                : `You've reached this lead before from ${shown}. They may not pick up a number they don't know.`}
            </span>
          );
        })()}
        {!(changed && defaultNumber.known) && (() => {
          // You call leads from a number in their county's area code. Say so when this one isn't, and offer one that is.
          const codes = d.county_area_codes ?? [];
          const chosen = activeNumbers.find((x) => x.id === numberId);
          if (!codes.length || !chosen || codes.includes(chosen.e164.slice(2, 5))) return null;
          const local = activeNumbers.find((x) => codes.includes(x.e164.slice(2, 5)) && x.reputation_status !== 'flagged');
          return (
            <span className="warn">
              {d.lead.county ?? 'This county'} uses {codes.join('/')}; this number is {chosen.e164.slice(2, 5)}.{' '}
              {local && (
                <button className="btn small" onClick={() => setNumberId(local.id)}>
                  Use {local.label ? `${local.label}, ` : ''}{fmtPhone(local.e164)}
                </button>
              )}
            </span>
          );
        })()}
        {activeNumbers.length === 0 && <span className="help">Add your numbers on the Numbers page to record which one you used.</span>}
      </div>
      {mode === 'appointment' && <div className="mode-label">How the appointment went</div>}
      <div className="outcomes" role="group" aria-label={mode === 'appointment' ? 'Appointment outcome' : 'Outcome'}>
        {outcomes.map((o) => (
          <button key={o.code} className={`${code === o.code ? 'active' : ''} ${o.marks_dead ? 'dead' : ''}`} onClick={() => choose(o.code)}>
            {keys.outcomeKey[o.code] && <kbd>{keyLabel(keys.outcomeKey[o.code]!)}</kbd>}{o.label}
          </button>
        ))}
        <label className={`choice-inline dnc ${doNotCall ? 'active' : ''}`} title="They asked not to be called again. Pick what happened on the call too; the lead goes to the dead pile.">
          <input type="checkbox" checked={doNotCall} onChange={(e) => setDoNotCall(e.target.checked)} />
          {k('do_not_call') && <kbd>{k('do_not_call')}</kbd>}Do not call
        </label>
      </div>
      {code && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          {needsWhen && (() => {
            const cb = readCallback(day, time, new Date(), d.lead.time_zone);
            const theirs = differentZone(d.lead.time_zone);
            return (
              <div className="callback-picker">
                <label className="field">
                  <span>Call back on</span>
                  <input id="callback-day" ref={dayRef} value={day} onChange={(e) => setDay(e.target.value)} onFocus={(e) => e.target.select()}
                    placeholder="t, m, fri, 10/24" style={{ width: 120 }} autoComplete="off" />
                </label>
                <label className="field">
                  <span>At (optional{theirs ? ', their time' : ''})</span>
                  <input id="callback-time" value={time} onChange={(e) => setTime(e.target.value)} placeholder="any time" style={{ width: 90 }} autoComplete="off" />
                </label>
                <span className={'error' in cb ? 'help warn' : 'help'} aria-live="polite">{'error' in cb ? (day ? cb.error : '') : describeCallback(cb, new Date(), d.lead.time_zone)}</span>
              </div>
            );
          })()}
          <label className="field">
            <span>Talk minutes {attempt.timerStart && outcome?.counts_as_human_contact ? '(blank: from the timer)' : '(optional)'}</span>
            <input id="log-minutes" type="number" min={0} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 90 }} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            <span>Note (optional)</span>
            <input id="log-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>Save <kbd>Enter</kbd></button>
          <button className="btn" onClick={() => setCode(null)}>Cancel <kbd>Esc</kbd></button>
        </div>
      )}
      {!code && (
        <p className="help">
          {calling?.settings.instant_save !== false
            ? mode === 'appointment'
              ? 'After the appointment, press the outcome key. No show saves right away; the others save with Enter.'
              : 'After the call, press the outcome key. No answer and Bad number save right away; the others save with Enter.'
            : 'After the call, press the outcome key, then Enter.'}{' '}
          Dialed more than once? Press <kbd>{k('dials_up')}</kbd> for each extra dial first.
        </p>
      )}
      {d.state?.status === 'invalid' && <RestoreBox d={d} onSaved={onRefresh} label={d.state.block_reason ? `${d.state.block_reason}.` : 'Marked as a bad number.'} />}
    </div>
  );
}

function RestoreBox({ d, onSaved, label }: { d: LeadDetail; onSaved: () => Promise<void>; label: string }) {
  const { toast } = useApp();
  const restore = async () => {
    try {
      await api.post(`/leads/${d.lead.id}/actions`, { action: 'restore', reason: 'restored from calling screen' });
      toast('Lead restored to the queue');
      await onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="card" style={{ marginTop: 10 }}>
      {label} <button className="btn small" onClick={restore}>Restore to queue</button>
    </div>
  );
}

/** The lead's latest call has the "Do not call" tick. */
function askedNotToCall(d: LeadDetail) {
  const last = d.calls.filter((c) => !c.voided_at).sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0];
  return !!last?.outcomes.some((o) => !o.superseded && o.do_not_call);
}
