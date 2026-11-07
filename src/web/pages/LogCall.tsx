import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { describeCallback, differentZone, readCallback, toWall } from '../when';
import { api, fmtPhone, newKey, type LeadDetail } from '../api';
import { useApp } from '../App';
import { CopyLeadLink, copyCalendarTag } from '../components/LeadDetails';
import { calendarTag } from '../../shared/leadLink';
import { isTyping, keyLabel, normKey, type KeyMap } from '../shortcuts';
import { getStored, setStored } from '../storage';
import type { CallMode } from '../../shared/appointments';
import { outcomeDef, savesInstantly } from '../../shared/outcomes';
import { buttonClass, type ButtonInfo } from '../../shared/buttons';
import { CustomFieldInput } from '../components/CustomFieldInput';

// The "log the call" form on the Calling screen: number used, outcome, callback time, minutes and note.
// It has two sides with the same layout: First call (no answer, appt set, ...) and Appointment (no show, prezi, sale, ...).

const LAST_NUMBER_KEY = 'mpcrm.lastNumber';

/** One attempt on the current lead: how many dials, when the timer started, which number was dialed. */
export interface Attempt {
  dials: number;
  timerStart: number | null;
  /** When you first pressed Dial for this attempt (with or without the timer). */
  dialedAt: number | null;
  to: string | null;
  /** When this lead came on screen, for the time spent on it. */
  shownAt: number;
}

/** What you had entered, put back after an undo. */
export interface FormValues {
  /** The button picked (an outcome's own button has the outcome's code). */
  button: string | null;
  /** Callback picker: the day and the optional time, as typed. */
  day: string;
  time: string;
  minutes: string;
  note: string;
  numberId: string | null;
  /** The "Do not call" tick. */
  doNotCall?: boolean;
  /** Objection codes you picked. */
  objections?: string[];
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
  /** Appt set with "Run it now": stay on this lead, on the Appointment side. */
  onTheSpot?: boolean;
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
  const [button, setButton] = useState<string | null>(restore?.button ?? null);
  const [day, setDay] = useState(restore?.day ?? '');
  const [time, setTime] = useState(restore?.time ?? '');
  const [minutes, setMinutes] = useState(restore?.minutes ?? '');
  const [note, setNote] = useState(restore?.note ?? '');
  const [doNotCall, setDoNotCall] = useState(!!restore?.doNotCall);
  const [objections, setObjections] = useState<string[]>(restore?.objections ?? []);
  // Your fields the picked button asks for (Settings → Buttons), as typed.
  const [asked, setAsked] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState(newKey());
  const dayRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!numberId && defaultNumber.id) setNumberId(defaultNumber.id);
  }, [defaultNumber.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The buttons on this side that show for this lead now (Settings → Buttons: shown, and its show-when is true).
  const buttons = useMemo(() => (meta?.buttons ?? []).filter((b) => b.side === mode && !b.hidden && !d.hidden_buttons?.includes(b.id)), [meta, mode, d.hidden_buttons]);
  const buttonOf = useCallback((id: string | null) => (id ? (meta?.buttons ?? []).find((b) => b.id === id) ?? null : null), [meta]);
  const picked = buttonOf(button);
  const code = picked?.outcome ?? null;
  const outcomeOf = useCallback((b: ButtonInfo | null) => (b ? meta?.outcome_codes.find((o) => o.code === b.outcome) ?? null : null), [meta]);
  const outcome = outcomeOf(picked);
  const needsWhen = !!outcome?.requires_callback_time;
  // Appt set: the appointment's day and time, optional, typed like a callback.
  const apptWhen = !!outcomeDef(code)?.apptSet;
  const objectionCodes = useMemo(() => meta?.objection_codes ?? [], [meta]);
  const asksObjections = !!outcomeDef(code)?.objections && objectionCodes.length > 0;
  const toggleObjection = useCallback((c: string) => setObjections((v) => (v.includes(c) ? v.filter((x) => x !== c) : [...v, c])), []);
  const changed = numberId !== defaultNumber.id;

  const choose = useCallback((id: string) => {
    const b = buttonOf(id);
    if (!b) return;
    if (b.confirm && !window.confirm(`${b.label}: are you sure?`)) return;
    setButton(id);
    setAsked(Object.fromEntries(d.custom.filter((f) => b.asks.includes(f.field_id)).map((f) => [f.field_id, f.value ?? ''])));
    // A button that asks for your fields waits for Enter, so you can fill them in.
    if (b.asks.length) {
      setTimeout(() => (document.querySelector('.asked-fields input, .asked-fields select') as HTMLElement | null)?.focus(), 0);
      return;
    }
    const c = b.outcome;
    const o = outcomeOf(b);
    if (o?.requires_callback_time) {
      setDay((v) => v || 'tomorrow');
      setTimeout(() => { dayRef.current?.focus(); dayRef.current?.select(); }, 0);
      return;
    }
    if (outcomeDef(c)?.apptSet) {
      setTimeout(() => dayRef.current?.focus(), 0);
      return;
    }
    // Outcomes set to save without Enter (by default No answer, Bad number and No show) save straight away; Undo still catches a wrong key.
    if (calling?.settings.instant_save !== false && o && savesInstantly(o, calling?.settings.instant_outcomes)) void saveRef.current(id);
  }, [buttonOf, outcomeOf, calling, d.custom]);

  // Talk time from the timer, only when someone picked up and you didn't type minutes yourself.
  const timerSeconds = (o: typeof outcome) =>
    attempt.timerStart && o?.counts_as_human_contact && calling?.settings.use_timer !== false
      ? Math.round((Date.now() - attempt.timerStart) / 1000)
      : null;

  /** `onTheSpot`: Appt set, and you're running it now (Shift+Enter): the appointment is now, whatever day was typed. */
  const save = useCallback(async (buttonNow: string | null = button, onTheSpot = false) => {
    const b = buttonOf(buttonNow);
    const codeNow = b?.outcome ?? null;
    if (!b || !codeNow || saving) return;
    const o = outcomeOf(b);
    const cb = o?.requires_callback_time ? readCallback(day, time, new Date(), d.lead.time_zone) : null;
    const isApptSet = !!outcomeDef(codeNow)?.apptSet;
    const spot = onTheSpot && isApptSet;
    const appt = spot ? { at: new Date(), anyTime: false } : isApptSet && day.trim() ? readCallback(day, time, new Date(), d.lead.time_zone) : null;
    const bad = cb && 'error' in cb ? cb : appt && 'error' in appt ? appt : null;
    if (bad) {
      toast(bad.error, 'error');
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
        button_id: b.id,
        fields: b.asks.length ? Object.fromEntries(b.asks.filter((f) => Object.hasOwn(asked, f)).map((f) => [f, asked[f]!.trim() || null])) : null,
        callback_due_at: cb && !('error' in cb) ? cb.at.toISOString() : null,
        callback_any_time: cb && !('error' in cb) ? cb.anyTime : null,
        appointment_for: appt && !('error' in appt) ? toWall(appt) : null,
        on_the_spot: spot,
        do_not_call: doNotCall,
        talk_seconds: minutes ? Number(minutes) * 60 : timerSeconds(o),
        dial_count: attempt.dials,
        lead_seconds: Math.round((Date.now() - attempt.shownAt) / 1000),
        dialed_at: attempt.dialedAt ? new Date(attempt.dialedAt).toISOString() : null,
        note: note || null,
        objections: outcomeDef(codeNow)?.objections ? objections.map((c) => ({ code: c })) : [],
      });
      if (numberId) setStored(LAST_NUMBER_KEY, numberId);
      setButton(null);
      setDay('');
      setTime('');
      setMinutes('');
      setNote('');
      setDoNotCall(false);
      setObjections([]);
      setAsked({});
      setKey(newKey());
      await onSaved({
        callId: r.call_id, leadId: d.lead.id, name: [d.lead.first_name, d.lead.last_name].filter(Boolean).join(' ') || 'this lead',
        label: `${b.label}${spot ? ', running it now' : ''}${doNotCall ? ', do not call' : ''}`, dials: attempt.dials, at: Date.now(),
        tz: d.lead.time_zone ?? null, onTheSpot: spot,
      });
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }, [button, buttonOf, outcomeOf, asked, saving, day, time, key, numberId, minutes, note, doNotCall, objections, d.lead.id, toast, onSaved, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveRef = useRef(save);
  saveRef.current = save;

  // Layout effect: the hotkeys are live as soon as the lead is on screen, so a fast keypress isn't lost.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-back') || !active) return;
      if (e.key === 'Enter' && button && (!isTyping(e) || e.ctrlKey || e.metaKey || ['callback-day', 'callback-time', 'log-note', 'log-minutes'].includes((e.target as HTMLElement).id) || !!(e.target as HTMLElement).closest?.('.asked-fields'))) {
        e.preventDefault();
        void save(button, e.shiftKey);
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') return setButton(null);
      // Shift + 1-9 picks an objection while the chips are showing.
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (e.shiftKey && digit && asksObjections) {
        const o = objectionCodes[Number(digit[1]) - 1];
        if (o) {
          e.preventDefault();
          toggleObjection(o.code);
        }
        return;
      }
      if (keys.actions.do_not_call?.includes(normKey(e.key))) {
        e.preventDefault();
        setDoNotCall((v) => !v);
        return;
      }
      // Action keys win over outcome keys (Settings warns about clashes).
      if (Object.values(keys.actions).some((ks) => ks.includes(normKey(e.key)))) return;
      // A key two buttons share goes to the first one showing for this lead.
      const c = keys.outcomes[mode].get(normKey(e.key))?.find((id) => buttons.some((b) => b.id === id));
      if (c) {
        e.preventDefault();
        choose(c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys, button, buttons, save, choose, active, mode, asksObjections, objectionCodes, toggleObjection]);

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
        {buttons.map((b) => (
          <button key={b.id} className={`${button === b.id ? 'active' : ''} ${outcomeDef(b.outcome)?.marksDead ? 'dead' : ''} ${buttonClass(b)}`} onClick={() => choose(b.id)}
            title={b.tooltip || undefined}>
            {keys.outcomeKey[b.id] && <kbd>{keyLabel(keys.outcomeKey[b.id]!)}</kbd>}{b.label}
          </button>
        ))}
        <label className={`choice-inline dnc ${doNotCall ? 'active' : ''}`} title="They asked not to be called again. Pick what happened on the call too; the lead goes to the dead pile.">
          <input type="checkbox" checked={doNotCall} onChange={(e) => setDoNotCall(e.target.checked)} />
          {k('do_not_call') && <kbd>{k('do_not_call')}</kbd>}Do not call
        </label>
      </div>
      {button && asksObjections && (
        <div className="objections" role="group" aria-label="Objections">
          <span className="help">What held them back? (optional)</span>
          {objectionCodes.map((o, i) => (
            <button key={o.code} className={objections.includes(o.code) ? 'active' : undefined} aria-pressed={objections.includes(o.code)} onClick={() => toggleObjection(o.code)}>
              {i < 9 && <kbd>⇧{i + 1}</kbd>}{o.label}
            </button>
          ))}
        </div>
      )}
      {picked && picked.asks.length > 0 && (
        <div className="row asked-fields" role="group" aria-label="Fields this button asks for">
          {d.custom.filter((f) => picked.asks.includes(f.field_id)).map((f) => (
            <label key={f.field_id} className="field">
              <span>{f.label}{f.required && <em className="warn"> (needed)</em>}</span>
              <CustomFieldInput field={f} value={asked[f.field_id] ?? ''} onChange={(v) => setAsked((a) => ({ ...a, [f.field_id]: v }))} />
            </label>
          ))}
        </div>
      )}
      {button && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          {(needsWhen || apptWhen) && (() => {
            const cb = readCallback(day, time, new Date(), d.lead.time_zone);
            const theirs = differentZone(d.lead.time_zone);
            return (
              <div className="callback-picker">
                <label className="field">
                  <span>{apptWhen ? 'Appointment on (optional)' : 'Call back on'}</span>
                  <input id="callback-day" ref={dayRef} value={day} onChange={(e) => setDay(e.target.value)} onFocus={(e) => e.target.select()}
                    placeholder="t, m, fri, 10/24" style={{ width: 120 }} autoComplete="off" />
                </label>
                <label className="field">
                  <span>At (optional{theirs ? ', their time' : ''})</span>
                  <input id="callback-time" value={time} onChange={(e) => setTime(e.target.value)} placeholder="any time" style={{ width: 90 }} autoComplete="off" />
                </label>
                {apptWhen && <CopyLeadLink leadId={d.lead.id} label="Copy link for Unitrust" />}
                {apptWhen && <button type="button" className="btn small" onClick={() => void copyCalendarTag(d.lead, toast)} title="What you type into your calendar">Copy {calendarTag(d.lead)}</button>}
                <span className={'error' in cb ? 'help warn' : 'help'} aria-live="polite">{'error' in cb ? (day ? cb.error : apptWhen ? 'Leave blank if you don\'t know yet; Unitrust fills it in.' : '') : describeCallback(cb, new Date(), d.lead.time_zone)}</span>
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
          {apptWhen && (
            <button className="btn" onClick={() => void save(button, true)} disabled={saving}
              title="On the spot: saves the appointment as set for now, stays on this lead and switches to the Appointment side, so you log how it went when you're done">
              Run it now <kbd>⇧Enter</kbd>
            </button>
          )}
          <button className="btn" onClick={() => setButton(null)}>Cancel <kbd>Esc</kbd></button>
        </div>
      )}
      {!button && (
        <p className="help">
          {saveHelp(mode, calling?.settings.instant_save !== false ? buttons.filter((b) => { const o = outcomeOf(b); return !!o && savesInstantly(o, calling?.settings.instant_outcomes); }) : [], buttons.length)}{' '}
          Dialed more than once? Press <kbd>{k('dials_up')}</kbd> for each extra dial first.
        </p>
      )}
      {d.state?.status === 'invalid' && <RestoreBox d={d} onSaved={onRefresh} label={d.state.block_reason ? `${d.state.block_reason}.` : 'Marked as a bad number.'} />}
    </div>
  );
}

/** How saving works on this side, e.g. "No answer and Bad number save right away; the others save with Enter." */
function saveHelp(mode: CallMode, instant: { label: string }[], total: number): string {
  const after = mode === 'appointment' ? 'After the appointment' : 'After the call';
  if (!instant.length) return `${after}, press the outcome key, then Enter.`;
  const names = instant.map((o) => o.label);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const verb = names.length > 1 ? 'save' : 'saves';
  return `${after}, press the outcome key. ${list} ${verb} right away${instant.length < total ? '; the others save with Enter' : ''}.`;
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
