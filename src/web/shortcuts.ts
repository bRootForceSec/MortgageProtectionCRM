import type { ButtonInfo } from '../shared/buttons';
import type { CallingSettings, ShortcutAction } from '../shared/callingSettings';
import type { CallMode } from '../shared/appointments';

// Keyboard shortcuts you can change in Settings. Each action can have several keys; each button has one.
// Button keys belong to a side of the Calling screen (First call or Appointment), so both sides can use 1 to 5.

export interface CallingSettingsResponse {
  settings: CallingSettings;
  actions: Record<ShortcutAction, { label: string; keys: string[] }>;
}

export interface KeyMap {
  actions: Record<ShortcutAction, string[]>;
  /** For each side of the Calling screen: key -> the buttons on it, in order (the first one showing wins). */
  outcomes: Record<CallMode, Map<string, string[]>>;
  /** button id -> key */
  outcomeKey: Record<string, string | null>;
  /** button id (an outcome's own button has the outcome's code) -> its side of the Calling screen */
  kinds: Record<string, CallMode>;
}

/** Keys are stored as KeyboardEvent.key values; letters in lower case. */
export function normKey(k: string): string {
  return k.length === 1 ? k.toLowerCase() : k;
}

export function buildKeyMap(r: CallingSettingsResponse | null, buttons: ButtonInfo[]): KeyMap {
  const actions = {} as Record<ShortcutAction, string[]>;
  for (const [a, def] of Object.entries(r?.actions ?? {}) as [ShortcutAction, { keys: string[] }][]) {
    actions[a] = (r?.settings.shortcuts.actions[a] ?? def.keys).map(normKey);
  }
  const outcomeKey: Record<string, string | null> = {};
  const map: KeyMap['outcomes'] = { first_call: new Map(), appointment: new Map() };
  for (const b of buttons) {
    if (b.hidden) continue;
    const over = r?.settings.shortcuts.outcomes[b.id];
    const k = over !== undefined ? over : b.default_key;
    outcomeKey[b.id] = k ? normKey(k) : null;
    if (k) map[b.side].set(normKey(k), [...(map[b.side].get(normKey(k)) ?? []), b.id]);
  }
  return { actions, outcomes: map, outcomeKey, kinds: Object.fromEntries(buttons.map((b) => [b.id, b.side])) };
}

export function isAction(km: KeyMap, a: ShortcutAction, e: KeyboardEvent): boolean {
  return (km.actions[a] ?? []).includes(normKey(e.key));
}

/** Keys used by more than one action, by an action and a button, or by two buttons on the same side. */
export function conflicts(km: KeyMap): Map<string, string[]> {
  const by = new Map<string, { who: string; side: CallMode | null }[]>();
  const add = (k: string, who: string, side: CallMode | null) => by.set(k, [...(by.get(k) ?? []), { who, side }]);
  for (const [a, keys] of Object.entries(km.actions)) for (const k of keys) add(k, a, null);
  for (const [code, k] of Object.entries(km.outcomeKey)) if (k) add(k, `outcome:${code}`, km.kinds[code] ?? 'first_call');
  const clash = (v: { side: CallMode | null }[]) =>
    v.filter((x) => x.side === null).length > 1 ||
    (v.some((x) => x.side === null) && v.some((x) => x.side !== null)) ||
    (['first_call', 'appointment'] as const).some((m) => v.filter((x) => x.side === m).length > 1);
  return new Map([...by].filter(([, v]) => clash(v)).map(([k, v]) => [k, v.map((x) => x.who)]));
}

const NAMES: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ' ': 'Space', Enter: 'Enter', Escape: 'Esc',
  Backspace: 'Backspace', Tab: 'Tab', Delete: 'Del',
};

export function keyLabel(k: string): string {
  return NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k);
}

/** Keys that can't be used as shortcuts because the app or browser needs them. */
export const RESERVED = new Set(['Enter', 'Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

