import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { chime } from '../components/CallbackAlerts';
import {
  buildKeyMap, conflicts, keyLabel, normKey, RESERVED, type CallingSettings, type CallingSettingsResponse, type ShortcutAction,
} from '../shortcuts';

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

export function CallingCard() {
  const { calling, toast } = useApp();
  const save = useSave();
  const [devices, setDevices] = useState<{ ok: boolean; error?: string; devices: { id: string; name: string; reachable: boolean }[] } | null>(null);
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const s = calling?.settings;
  useEffect(() => {
    if (s?.dial_method === 'kdeconnect') api.get<typeof devices>('/dial/devices').then(setDevices).catch(() => {});
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
          <label className="choice-inline"><input type="checkbox" checked={s.instant_save} onChange={(e) => set({ instant_save: e.target.checked })} /> No answer and Bad number save as soon as I press the key (no Enter). Undo still works.</label>
        </span>

        <label>Call timer</label>
        <span>
          <label className="choice-inline"><input type="checkbox" checked={s.use_timer} onChange={(e) => set({ use_timer: e.target.checked })} /> start when I dial, and fill talk minutes when someone picks up</label>
        </span>

        <label>Daily goals</label>
        <span className="row">
          <span>Dials <NumberField value={s.goals.dials} allowBlank onSave={(n) => set({ goals: { ...s.goals, dials: n } })} /></span>
          <span>Contacts <NumberField value={s.goals.contacts} allowBlank onSave={(n) => set({ goals: { ...s.goals, contacts: n } })} /></span>
          <span>Appointments <NumberField value={s.goals.appointments} allowBlank onSave={(n) => set({ goals: { ...s.goals, appointments: n } })} /></span>
          <span className="help">Shown in the top bar. Leave blank for none.</span>
        </span>

        <label>Callback alerts</label>
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
          Alert <NumberField value={s.alerts.minutes_before} onSave={(n) => set({ alerts: { ...s.alerts, minutes_before: n ?? 0 } })} width={70} /> minutes before it's due
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
  const km = useMemo(() => buildKeyMap(calling, meta?.outcome_codes ?? []), [calling, meta]);
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
    (clash.get(k) ?? []).map((w) => (w.startsWith('outcome:') ? meta?.outcome_codes.find((o) => `outcome:${o.code}` === w)?.label : calling.actions[w as ShortcutAction]?.label)).filter(Boolean);
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
      {clash.size > 0 && <p className="warn">Some keys do two things (marked in orange). The action wins over the outcome.</p>}
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
          {meta?.outcome_codes.map((o) => {
            const k = km.outcomeKey[o.code];
            const waiting = capture?.kind === 'outcome' && capture.id === o.code;
            return (
              <tr key={o.code}>
                <td>Outcome: {o.label}</td>
                <td>
                  {k || waiting ? (
                    <Key k={k ?? ''} waiting={waiting} onClick={() => setCapture({ kind: 'outcome', id: o.code })}
                      onRemove={k ? () => save({ ...s, shortcuts: { ...s.shortcuts, outcomes: { ...s.shortcuts.outcomes, [o.code]: null } } }) : undefined} />
                  ) : (
                    <button className="btn small" onClick={() => setCapture({ kind: 'outcome', id: o.code })}>+ key</button>
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

export function ScriptsCard() {
  const { calling } = useApp();
  const save = useSave();
  const s = calling?.settings;
  const [v, setV] = useState(s?.scripts ?? { agent_name: '', opener: '', voicemail: '' });
  // Reload the boxes only when the saved scripts themselves change, so saving another setting
  // never wipes what you're typing here.
  const savedJson = JSON.stringify(s?.scripts ?? null);
  useEffect(() => {
    if (s) setV(s.scripts);
  }, [savedJson]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const dirty = JSON.stringify(v) !== JSON.stringify(s.scripts);
  return (
    <div className="card">
      <h2>Scripts</h2>
      <p className="help">
        Shown on the Calling screen (press <kbd>{keyLabel(s.shortcuts.actions.script?.[0] ?? 'p')}</kbd>). These fill in from the lead:{' '}
        <code>{'{first_name}'}</code> <code>{'{last_name}'}</code> <code>{'{lender}'}</code> <code>{'{loan_amount}'}</code> <code>{'{address}'}</code>{' '}
        <code>{'{city}'}</code> <code>{'{county}'}</code> <code>{'{state}'}</code> <code>{'{age}'}</code> <code>{'{agent_name}'}</code>. A blank one shows as ____.
      </p>
      <label className="field"><span>Your name, as you say it on calls</span><input value={v.agent_name} onChange={(e) => setV({ ...v, agent_name: e.target.value })} /></label>
      <label className="field"><span>Opener</span><textarea rows={5} value={v.opener} onChange={(e) => setV({ ...v, opener: e.target.value })} placeholder="Hi {first_name}, this is {agent_name}. I'm calling about the mortgage protection form for your home on {address}…" /></label>
      <label className="field"><span>Voicemail</span><textarea rows={4} value={v.voicemail} onChange={(e) => setV({ ...v, voicemail: e.target.value })} /></label>
      <button className="btn primary" disabled={!dirty} onClick={() => save({ ...s, scripts: v })}>Save scripts</button>
    </div>
  );
}
