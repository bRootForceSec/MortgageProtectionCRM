import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { chime } from '../components/CallbackAlerts';
import {
  buildKeyMap, conflicts, keyLabel, normKey, RESERVED, type CallingSettingsResponse,
} from '../shortcuts';
import { STARTER_CALLABLE, type CallingSettings, type ShortcutAction } from '../../shared/callingSettings';
import { parsePlan, SUGGESTED_FOLLOW_UPS } from '../../shared/followUps';
import { savesInstantly } from '../../shared/outcomes';
import { APPT_RESULT_LABEL } from '../../shared/appointments';
import { ConditionEditor } from '../components/ConditionEditor';
import { STARTER_ORDER, type SortStep } from '../../shared/listOrder';
import { LEAD_FACTS, SHEET_BLOCKS, sheetBlocks, sheetFacts, type SheetLayout } from '../../shared/sheetLayout';
import { useCustomFields } from '../customFields';
import { bestTimeWords, hourWords } from '../../shared/bestTime';

// Settings for the Calling screen: retry gap, dialing, timer, goals, alerts, shortcuts and scripts.

function useSave() {
  const { calling, setCalling, toast } = useApp();
  return async (next: CallingSettings) => {
    if (!calling) return;
    setCalling({ ...calling, settings: next });
    try {
      setCalling(await api.put<CallingSettingsResponse>('/settings/calling', next));
    } catch (e: any) {
      toast(e.message, 'error');
      setCalling(calling);
    }
  };
}

/** A number input that saves when you leave it. Blank means "none" when allowBlank. */
function NumberField({ value, onSave, min = 0, allowBlank, width = 90 }: { value: number | null; onSave: (n: number | null) => void; min?: number; allowBlank?: boolean; width?: number }) {
  const [v, setV] = useState(value == null ? '' : String(value));
  useEffect(() => setV(value == null ? '' : String(value)), [value]);
  const commit = () => {
    if (v.trim() === '') return allowBlank ? onSave(null) : setV(String(value ?? ''));
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min) return setV(String(value ?? ''));
    if (n !== value) onSave(n);
  };
  return <input type="number" min={min} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} style={{ width }} />;
}

/** A follow-up plan typed as "15m, 1d@09:00, 3d". A plan that isn't understood is not saved. */
function PlanField({ value, onSave }: { value: string[]; onSave: (steps: string[]) => void }) {
  const { toast } = useApp();
  const [v, setV] = useState(value.join(', '));
  useEffect(() => setV(value.join(', ')), [value]);
  const commit = () => {
    const steps = parsePlan(v);
    if (!steps) {
      toast('Write each step like 15m, 2h, 3d or 1d@09:00, separated by commas', 'error');
      return setV(value.join(', '));
    }
    if (steps.join() !== value.join()) onSave(steps);
  };
  return <input value={v} placeholder="none: due right away" onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} style={{ width: 200 }} />;
}

/** A formula typed into a sort step; saved when you leave it (the server says if it's a mistake). */
function FormulaInput({ value, onSave }: { value: string; onSave: (f: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => (v.trim() && v.trim() !== value ? onSave(v.trim()) : setV(value));
  return <input aria-label="Sort by" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} style={{ flex: 1, minWidth: 200 }} />;
}

/** "Your order" on the call list: sort steps, first to last. */
function ListOrderField({ steps, words, onSave }: { steps: SortStep[]; words: string; onSave: (steps: SortStep[]) => void }) {
  const put = (i: number, st: SortStep) => onSave(steps.map((x, j) => (j === i ? st : x)));
  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onSave(next);
  };
  const same = JSON.stringify(steps) === JSON.stringify(STARTER_ORDER);
  return (
    <span>
      <ol aria-label="Call list order" style={{ margin: 0, paddingLeft: 20 }}>
        {steps.map((st, i) => (
          <li key={i}>
            <span className="row" style={{ gap: 6 }}>
              <select aria-label="Sort step" value={st.by} onChange={(e) => put(i, e.target.value === 'best_time' ? { by: 'best_time' } : { by: 'formula', formula: 'has("Hot")', lowest_first: false })}>
                <option value="best_time">Best time to call now</option>
                <option value="formula">A formula</option>
              </select>
              {st.by === 'best_time' && <span className="help" style={{ flex: 1 }}>{words}</span>}
              {st.by === 'formula' && (
                <>
                  <FormulaInput value={st.formula} onSave={(f) => put(i, { ...st, formula: f })} />
                  <label className="choice-inline" title="Turns the step around: lowest number first, or for a yes/no, no first">
                    <input type="checkbox" checked={st.lowest_first} onChange={(e) => put(i, { ...st, lowest_first: e.target.checked })} /> lowest first
                  </label>
                </>
              )}
              <button type="button" className="btn small" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="btn small" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="btn small" aria-label="Remove step" onClick={() => onSave(steps.filter((_, j) => j !== i))}>✕</button>
            </span>
          </li>
        ))}
      </ol>
      <span className="row" style={{ gap: 6 }}>
        {steps.length < 10 && (
          <button type="button" className="btn small" onClick={() => onSave([...steps, { by: 'formula', formula: 'has("Hot")', lowest_first: false }])}>Add a step</button>
        )}
        {!same && <button type="button" className="btn small" onClick={() => onSave(STARTER_ORDER)}>Back to the start</button>}
      </span>
      <span className="help">
        "Your order" on the Calling screen sorts the leads still to call by these, first to last: the first step that tells two leads apart decides.
        A yes/no formula, like <code>has("Hot")</code> or <code>in_list("Needs rebook")</code>, puts the leads it's true for first. A number, like{' '}
        <code>loan_amount</code> or <code>attempts</code>, puts the highest first; leads without one go last. Lowest first turns a step around.
        Leads every step ties stay as they are on the list.
      </span>
    </span>
  );
}

export function CallingCard() {
  const { calling, meta, toast } = useApp();
  const save = useSave();
  const [devices, setDevices] = useState<{ ok: boolean; error?: string; devices: { id: string; name: string; reachable: boolean }[] } | null>(null);
  const [editCallable, setEditCallable] = useState(false);
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const s = calling?.settings;
  useEffect(() => {
    if (s?.dial_method === 'kdeconnect') api.get<typeof devices>('/dial/devices').then(setDevices).catch((e: Error) => setDevices({ ok: false, error: e.message, devices: [] }));
  }, [s?.dial_method]);
  if (!s) return null;
  const set = (patch: Partial<CallingSettings>) => save({ ...s, ...patch });

  const testDial = async () => {
    const n = window.prompt('Send which number to your phone? (10 digits)');
    const d = n?.replace(/\D/g, '');
    if (!d || d.length !== 10) return;
    try {
      await api.post('/dial', { to_e164: `+1${d}` });
      toast('Sent. Your phone should open the dialer.');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="card">
      <h2>Calling</h2>
      <div className="settings-grid">
        <label>Who can be called</label>
        <span>
          <span className="row" style={{ gap: 6 }}>
            {s.callable_when ? <>Leads where <code aria-label="Can be called when">{s.callable_when}</code></> : 'Every lead'}
            <button type="button" className="btn small" onClick={() => setEditCallable(true)}>Edit</button>
            {s.callable_when !== STARTER_CALLABLE && <button type="button" className="btn small" onClick={() => set({ callable_when: STARTER_CALLABLE })}>Back to the start</button>}
          </span>
          {editCallable && (
            <ConditionEditor value={s.callable_when} onApply={(c) => { set({ callable_when: c }); setEditCallable(false); }} onCancel={() => setEditCallable(false)} />
          )}
          <span className="help">
            Only these leads can go on the call list (by hand or by a rule), and the Calling screen only dials them by itself.
            It starts as every lead but booked ones. Leads in the dead pile or with no good number are never called, and nor is a lead with a never-dial tag unless you say so.
          </span>
        </span>

        <label>Dial button (<kbd>{keyLabel(calling.settings.shortcuts.actions.dial?.[0] ?? 'c')}</kbd>)</label>
        <span className="choices">
          {([
            ['copy', 'Copy the number', 'Paste it into Sideline or your dialer.'],
            ['qr', 'Show a QR code', 'Scan it with your phone camera to call. Works on Android and iPhone.'],
            ['kdeconnect', 'Send to my phone with KDE Connect', 'Your phone opens its dialer with the number filled in. Needs KDE Connect on this computer and the phone.'],
          ] as const).map(([v, label, help]) => (
            <label key={v} className="choice">
              <input type="radio" name="dial_method" checked={s.dial_method === v} onChange={() => set({ dial_method: v })} />
              <span><b>{label}</b><br /><span className="help">{help}</span></span>
            </label>
          ))}
        </span>

        {s.dial_method === 'kdeconnect' && (
          <>
            <label>Phone</label>
            <span>
              {!devices ? 'Looking for phones…' : !devices.ok ? (
                <span className="error">{devices.error} On Fedora: <code>sudo dnf install kdeconnectd</code>, then pair the phone in the KDE Connect app.</span>
              ) : devices.devices.length === 0 ? (
                <span className="warn">No paired phones. Pair your phone in the KDE Connect app first.</span>
              ) : (
                <select value={s.kdeconnect_device ?? ''} onChange={(e) => set({ kdeconnect_device: e.target.value || null })}>
                  <option value="">Choose your phone…</option>
                  {devices.devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.reachable ? '' : ' (not connected now)'}</option>)}
                </select>
              )}{' '}
              <button className="btn small" onClick={() => api.get<typeof devices>('/dial/devices').then(setDevices)}>Look again</button>{' '}
              {s.kdeconnect_device && <button className="btn small" onClick={testDial}>Test</button>}
              <br />
              <label className="choice-inline"><input type="checkbox" checked={s.auto_send_next} onChange={(e) => set({ auto_send_next: e.target.checked })} /> send the next lead's number to my phone as soon as I save or skip</label>
            </span>
          </>
        )}

        <label>Saving</label>
        <span>
          <label className="choice-inline"><input type="checkbox" checked={s.instant_save} onChange={(e) => set({ instant_save: e.target.checked })} /> some outcomes save as soon as I press the key (no Enter). Undo still works.</label>
          {s.instant_save && (['first_call', 'appointment'] as const).map((side) => (
            <span key={side} className="row" style={{ marginTop: 4 }}>
              <span className="help">{side === 'appointment' ? 'Appointments:' : 'Calls:'}</span>
              {(meta?.outcome_codes ?? []).filter((o) => o.kind === side && !o.requires_callback_time && o.offered).map((o) => (
                <label key={o.code} className="choice-inline">
                  <input type="checkbox" checked={savesInstantly(o, s.instant_outcomes)}
                    onChange={(e) => set({ instant_outcomes: { ...s.instant_outcomes, [o.code]: e.target.checked } })} /> {o.label}
                </label>
              ))}
            </span>
          ))}
          {s.instant_save && <span className="help">Ticked outcomes save without Enter. Talk minutes come from the timer. Callbacks always wait for their day.</span>}
        </span>

        <label>Missed appointments</label>
        <span>
          <label className="choice-inline"><input type="checkbox" checked={s.missed_appts_first} onChange={(e) => set({ missed_appts_first: e.target.checked })} /> put a lead a no-show, appt picked up or presentation sent back at the top of the call list when I add it</label>
        </span>

        <label>Call list order</label>
        <ListOrderField steps={s.list_order} words={bestTimeWords(s.best_time)} onSave={(list_order) => set({ list_order })} />

        <label>Best time to call</label>
        <span>
          <span className="row" style={{ gap: 6 }}>
            Call leads from
            <select aria-label="Calling hours start" value={s.best_time.from_hour} onChange={(e) => set({ best_time: { ...s.best_time, from_hour: Number(e.target.value) } })}>
              {HOURS.filter((h) => h < 24 && h < s.best_time.to_hour).map((h) => <option key={h} value={h}>{hourWords(h)}</option>)}
            </select>
            until
            <select aria-label="Calling hours end" value={s.best_time.to_hour} onChange={(e) => set({ best_time: { ...s.best_time, to_hour: Number(e.target.value) } })}>
              {HOURS.filter((h) => h > s.best_time.from_hour).map((h) => <option key={h} value={h}>{hourWords(h)}</option>)}
            </select>
            their time; trust my own pickup rate at an hour once I have
            <input type="number" aria-label="Calls an hour needs" min={1} max={1000} value={s.best_time.min_calls} style={{ width: 70 }}
              onChange={(e) => Number(e.target.value) >= 1 && set({ best_time: { ...s.best_time, min_calls: Math.round(Number(e.target.value)) } })} />
            calls there
          </span>
          <span className="help">{bestTimeWords(s.best_time)} The Best time to call report in Reports shows the rates it reads.</span>
        </span>

        <label>Follow-ups</label>
        <span>
          {(['no_show', 'sat_no_sale', 'prezi'] as const).map((r) => (
            <span key={r} className="row">
              <span style={{ width: 110 }}>{APPT_RESULT_LABEL[r]}</span>
              <PlanField value={s.follow_ups[r]} onSave={(steps) => set({ follow_ups: { ...s.follow_ups, [r]: steps } })} />
              {!s.follow_ups[r].length && (
                <button className="btn small" onClick={() => set({ follow_ups: { ...s.follow_ups, [r]: SUGGESTED_FOLLOW_UPS[r] } })}>Use {SUGGESTED_FOLLOW_UPS[r].join(', ')}</button>
              )}
            </span>
          ))}
          <span className="help">
            When to try again after that result: each step is a callback, timed from the result and then from each try nobody answered.
            15m, 2h and 3d are minutes, hours and days later; 1d@09:00 is the next day at 9 AM. When someone answers, or the steps run out,
            the usual retry takes over. With no steps, the lead is due right away. The same plans are ready-made rules too
            (Automation → Rules, "Make it come back"), where you can change what sets them off.
          </span>
        </span>

        <label>Call timer</label>
        <span>
          <label className="choice-inline"><input type="checkbox" checked={s.use_timer} onChange={(e) => set({ use_timer: e.target.checked })} /> start when I dial, and fill talk minutes when someone picks up</label>
        </span>

        <label>Daily goals</label>
        <span className="row">
          <span>Dials <NumberField value={s.goals.dials} allowBlank onSave={(n) => set({ goals: { ...s.goals, dials: n } })} /></span>
          <span>Pickups <NumberField value={s.goals.contacts} allowBlank onSave={(n) => set({ goals: { ...s.goals, contacts: n } })} /></span>
          <span>Appts set <NumberField value={s.goals.appointments} allowBlank onSave={(n) => set({ goals: { ...s.goals, appointments: n } })} /></span>
          <span className="help">Shown in the top bar. Leave blank for none.</span>
        </span>

        <label>Callback and appointment alerts</label>
        <span>
          <label className="choice-inline"><input type="checkbox" checked={s.alerts.desktop} onChange={(e) => set({ alerts: { ...s.alerts, desktop: e.target.checked } })} /> desktop notification</label>{' '}
          {s.alerts.desktop && perm !== 'granted' && perm !== 'unsupported' && (
            <button className="btn small" onClick={async () => setPerm(await Notification.requestPermission())}>Allow notifications</button>
          )}
          {perm === 'denied' && <span className="warn"> Notifications are blocked in the browser. Allow them for this site in the browser's settings.</span>}
          <br />
          <label className="choice-inline"><input type="checkbox" checked={s.alerts.sound} onChange={(e) => set({ alerts: { ...s.alerts, sound: e.target.checked } })} /> sound</label>{' '}
          <button className="btn small" onClick={chime}>Play it</button>
          <br />
          Alert <NumberField value={s.alerts.minutes_before} onSave={(n) => set({ alerts: { ...s.alerts, minutes_before: n ?? 0 } })} width={70} /> minutes before a callback is due
          <br />
          Alert <NumberField value={s.alerts.appt_minutes_before} allowBlank onSave={(n) => set({ alerts: { ...s.alerts, appt_minutes_before: n } })} width={70} /> minutes before an appointment
          <span className="help"> (leave it empty for no appointment alerts)</span>
          <br />
          <span className="help"> (only while the app is open)</span>
        </span>
      </div>
    </div>
  );
}

export function ShortcutsCard() {
  const { calling, meta } = useApp();
  const save = useSave();
  const [capture, setCapture] = useState<{ kind: 'action'; id: ShortcutAction; index: number } | { kind: 'outcome'; id: string } | null>(null);
  const km = useMemo(() => buildKeyMap(calling, meta?.buttons ?? []), [calling, meta]);
  const clash = useMemo(() => conflicts(km), [km]);
  const s = calling?.settings;

  useEffect(() => {
    if (!capture || !s) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setCapture(null);
      if (RESERVED.has(e.key)) return;
      const k = normKey(e.key);
      if (capture.kind === 'action') {
        const cur = [...(km.actions[capture.id] ?? [])];
        cur[capture.index] = k;
        void save({ ...s, shortcuts: { ...s.shortcuts, actions: { ...s.shortcuts.actions, [capture.id]: [...new Set(cur)] } } });
      } else {
        void save({ ...s, shortcuts: { ...s.shortcuts, outcomes: { ...s.shortcuts.outcomes, [capture.id]: k } } });
      }
      setCapture(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capture, s, km, save]);

  if (!s || !calling) return null;
  const setAction = (a: ShortcutAction, keys: string[]) => save({ ...s, shortcuts: { ...s.shortcuts, actions: { ...s.shortcuts.actions, [a]: keys } } });
  const who = (k: string) =>
    (clash.get(k) ?? []).map((w) => (w.startsWith('outcome:') ? meta?.buttons.find((b) => `outcome:${b.id}` === w)?.label : calling.actions[w as ShortcutAction]?.label)).filter(Boolean);
  const Key = ({ k, onClick, onRemove, waiting }: { k: string; onClick: () => void; onRemove?: () => void; waiting: boolean }) => (
    <span className={`chip ${clash.has(k) ? 'clash' : ''}`} title={clash.has(k) ? `Also used by: ${who(k).join(', ')}` : 'Click to change'}>
      <button className="keycap" onClick={onClick}>{waiting ? 'press a key…' : keyLabel(k)}</button>
      {onRemove && <button onClick={onRemove} aria-label={`Remove ${keyLabel(k)}`}>×</button>}
    </span>
  );

  return (
    <div className="card">
      <h2>Keyboard shortcuts</h2>
      <p className="help">Click a key to change it, then press the new key (Esc to keep the old one). Shortcuts work when you're not typing in a box. Enter saves and Esc cancels; those can't be changed.</p>
      {clash.size > 0 && <p className="warn">Some keys do two things (marked in orange). The action wins over a button, and of two buttons the first one showing wins.</p>}
      <table className="grid shortcuts">
        <tbody>
          {(Object.keys(calling.actions) as ShortcutAction[]).map((a) => {
            const keys = km.actions[a] ?? [];
            return (
              <tr key={a}>
                <td>{calling.actions[a].label}</td>
                <td>
                  {keys.map((k, i) => (
                    <Key key={`${k}-${i}`} k={k} waiting={capture?.kind === 'action' && capture.id === a && capture.index === i}
                      onClick={() => setCapture({ kind: 'action', id: a, index: i })}
                      onRemove={keys.length > 1 ? () => setAction(a, keys.filter((_, j) => j !== i)) : undefined} />
                  ))}
                  {keys.length < 5 && (
                    capture?.kind === 'action' && capture.id === a && capture.index === keys.length
                      ? <span className="chip"><button className="keycap">press a key…</button></span>
                      : <button className="btn small" onClick={() => setCapture({ kind: 'action', id: a, index: keys.length })}>+ key</button>
                  )}
                </td>
              </tr>
            );
          })}
          {meta?.buttons.filter((b) => !b.hidden).map((b) => {
            const k = km.outcomeKey[b.id];
            const waiting = capture?.kind === 'outcome' && capture.id === b.id;
            return (
              <tr key={b.id}>
                <td>Button: {b.label}</td>
                <td>
                  {k || waiting ? (
                    <Key k={k ?? ''} waiting={waiting} onClick={() => setCapture({ kind: 'outcome', id: b.id })}
                      onRemove={k ? () => save({ ...s, shortcuts: { ...s.shortcuts, outcomes: { ...s.shortcuts.outcomes, [b.id]: null } } }) : undefined} />
                  ) : (
                    <button className="btn small" onClick={() => setCapture({ kind: 'outcome', id: b.id })}>+ key</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="btn small" onClick={() => window.confirm('Put every shortcut back to how it came?') && save({ ...s, shortcuts: { actions: {}, outcomes: {} } })}>
        Reset to defaults
      </button>
    </div>
  );
}

/** The lead sheet on the Calling screen as blocks: show or hide each one and put them in order. */
export function SheetCard() {
  const { calling } = useApp();
  const save = useSave();
  const { fields } = useCustomFields();
  const [name, setName] = useState('');
  const s = calling?.settings;
  if (!s) return null;
  const blocks = sheetBlocks(s.sheet);
  const put = (next: typeof blocks) => void save({ ...s, sheet: { ...s.sheet, blocks: next } });
  const setSheet = (patch: Partial<SheetLayout>) => void save({ ...s, sheet: { ...s.sheet, ...patch } });
  const facts = sheetFacts(s.sheet, fields.map((f) => f.id));
  const factLabel = (id: string) => LEAD_FACTS.find((f) => f.id === id)?.label ?? fields.find((f) => `field:${f.id}` === id)?.label ?? id;
  const moveFact = (i: number, j: number) => {
    const next = [...facts];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSheet({ facts: next });
  };
  const move = (i: number, j: number) => {
    const next = [...blocks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    put(next);
  };
  return (
    <div className="card" id="lead-sheet">
      <h2>Lead sheet</h2>
      <p className="help">
        The middle of the Calling screen, top to bottom. Tick a block to show it, and move it with the arrows. The never-dial warning always comes first
        when a lead has a never-dial tag, and the outcome buttons always show because they save the call. Tags right under Lead info sit beside its buttons,
        and Calls just above Notes share a row.
      </p>
      <ol className="sheet-blocks">
        {blocks.map((b, i) => {
          const def = SHEET_BLOCKS.find((x) => x.id === b.id)!;
          return (
            <li key={b.id}>
              <label className="choice-inline" title={def.help}>
                <input type="checkbox" checked={b.shown} disabled={b.id === 'outcome'} aria-label={`Show ${def.label}`}
                  onChange={() => put(blocks.map((x) => (x.id === b.id ? { ...x, shown: !x.shown } : x)))} />
                {def.label}
              </label>
              <span className="help"> {def.help}</span>
              <button className="btn small" aria-label={`Move ${def.label} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
              <button className="btn small" aria-label={`Move ${def.label} down`} disabled={i === blocks.length - 1} onClick={() => move(i, i + 1)}>↓</button>
            </li>
          );
        })}
      </ol>
      <label className="choice-inline">
        <input type="checkbox" checked={s.sheet.dial_counter} onChange={() => void save({ ...s, sheet: { ...s.sheet, dial_counter: !s.sheet.dial_counter } })} />
        Show the dial counter and timer above the buttons
      </label>
      <label className="choice-inline">
        <input type="checkbox" checked={s.sheet.caller_id} onChange={() => void save({ ...s, sheet: { ...s.sheet, caller_id: !s.sheet.caller_id } })} />
        Show which of your numbers you called from (hidden, the call still records the number it would have picked)
      </label>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <label className="choice-inline">
          Calls: show the last
          <input type="number" aria-label="Calls to show" min={0} max={200} value={s.sheet.calls_shown} style={{ width: 60 }}
            onChange={(e) => Number(e.target.value) >= 0 && setSheet({ calls_shown: Math.round(Number(e.target.value)) })} />
          (0 for all)
        </label>
        <label className="choice-inline">
          Notes: the box for a new note is
          <input type="number" aria-label="Note box lines" min={1} max={30} value={s.sheet.notes_rows} style={{ width: 60 }}
            onChange={(e) => Number(e.target.value) >= 1 && setSheet({ notes_rows: Math.round(Number(e.target.value)) })} />
          lines tall
        </label>
      </div>

      <h3>Lead info</h3>
      <p className="help">Which facts about the lead show under its name, top to bottom. Your fields are here too; one with a show-when condition still shows only while it's true.</p>
      <ol className="sheet-blocks" aria-label="Lead info facts">
        {facts.map((f, i) => (
          <li key={f.id}>
            <label className="choice-inline">
              <input type="checkbox" checked={f.shown} aria-label={`Show ${factLabel(f.id)}`} onChange={() => setSheet({ facts: facts.map((x) => (x.id === f.id ? { ...x, shown: !x.shown } : x)) })} />
              {factLabel(f.id)}
            </label>
            <button className="btn small" aria-label={`Move ${factLabel(f.id)} up`} disabled={i === 0} onClick={() => moveFact(i, i - 1)}>↑</button>
            <button className="btn small" aria-label={`Move ${factLabel(f.id)} down`} disabled={i === facts.length - 1} onClick={() => moveFact(i, i + 1)}>↓</button>
          </li>
        ))}
      </ol>

      <h3>Saved lead sheets</h3>
      <p className="help">Save this lead sheet under a name, like "New leads" or "Appointment call-backs", and switch to it here or on the Calling screen.</p>
      {s.sheet_layouts.length > 0 && (
        <ul className="plain" aria-label="Saved lead sheets">
          {s.sheet_layouts.map((l) => (
            <li key={l.name} className="row" style={{ gap: 6 }}>
              <b>{l.name}</b>
              <button className="btn small" onClick={() => void save({ ...s, sheet: l.sheet })}>Use it</button>
              <button className="btn small" onClick={() => void save({ ...s, sheet_layouts: s.sheet_layouts.map((x) => (x.name === l.name ? { ...x, sheet: s.sheet } : x)) })}
                title="Saves the lead sheet as it is now under this name">Save over it</button>
              <button className="btn small" aria-label={`Delete ${l.name}`} onClick={() => void save({ ...s, sheet_layouts: s.sheet_layouts.filter((x) => x.name !== l.name) })}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <span className="row" style={{ gap: 6 }}>
        <input aria-label="Name for this lead sheet" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button className="btn small" disabled={!name.trim() || s.sheet_layouts.length >= 20} onClick={() => {
          const n = name.trim();
          void save({ ...s, sheet_layouts: [...s.sheet_layouts.filter((x) => x.name.toLowerCase() !== n.toLowerCase()), { name: n, sheet: s.sheet }] });
          setName('');
        }}>Save this lead sheet</button>
      </span>
    </div>
  );
}

const HOURS = Array.from({ length: 25 }, (_, h) => h);
