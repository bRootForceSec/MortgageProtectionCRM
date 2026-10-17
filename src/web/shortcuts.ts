import type { OutcomeCode } from './api';

// Keyboard shortcuts you can change in Settings. Each action can have several keys; each outcome has one.

export type ShortcutAction = 'dial' | 'dials_up' | 'dials_down' | 'next' | 'skip' | 'undo' | 'note' | 'search' | 'edit' | 'script';

export interface CallingSettings {
  retry_gap_minutes: number;
  auto_advance: boolean;
  dial_method: 'copy' | 'qr' | 'kdeconnect';
  kdeconnect_device: string | null;
  use_timer: boolean;
  shortcuts: { actions: Partial<Record<ShortcutAction, string[]>>; outcomes: Record<string, string | null> };
  scripts: { agent_name: string; opener: string; voicemail: string };
  goals: { dials: number | null; contacts: number | null; appointments: number | null };
  alerts: { desktop: boolean; sound: boolean; minutes_before: number };
}

export interface CallingSettingsResponse {
  settings: CallingSettings;
  actions: Record<ShortcutAction, { label: string; keys: string[] }>;
}

export interface KeyMap {
  actions: Record<ShortcutAction, string[]>;
  /** key -> outcome code */
  outcomes: Map<string, string>;
  /** outcome code -> key */
  outcomeKey: Record<string, string | null>;
}

/** Keys are stored as KeyboardEvent.key values; letters in lower case. */
export function normKey(k: string): string {
  return k.length === 1 ? k.toLowerCase() : k;
}

export function buildKeyMap(r: CallingSettingsResponse | null, outcomes: OutcomeCode[]): KeyMap {
  const actions = {} as Record<ShortcutAction, string[]>;
  for (const [a, def] of Object.entries(r?.actions ?? {}) as [ShortcutAction, { keys: string[] }][]) {
    actions[a] = (r?.settings.shortcuts.actions[a] ?? def.keys).map(normKey);
  }
  const outcomeKey: Record<string, string | null> = {};
  const map = new Map<string, string>();
  for (const o of outcomes) {
    const over = r?.settings.shortcuts.outcomes[o.code];
    const k = over !== undefined ? over : o.hotkey;
    outcomeKey[o.code] = k ? normKey(k) : null;
    if (k) map.set(normKey(k), o.code);
  }
  return { actions, outcomes: map, outcomeKey };
}

export function isAction(km: KeyMap, a: ShortcutAction, e: KeyboardEvent): boolean {
  return (km.actions[a] ?? []).includes(normKey(e.key));
}

/** Keys used by more than one action or outcome. */
export function conflicts(km: KeyMap): Map<string, string[]> {
  const by = new Map<string, string[]>();
  const add = (k: string, who: string) => by.set(k, [...(by.get(k) ?? []), who]);
  for (const [a, keys] of Object.entries(km.actions)) for (const k of keys) add(k, a);
  for (const [code, k] of Object.entries(km.outcomeKey)) if (k) add(k, `outcome:${code}`);
  return new Map([...by].filter(([, v]) => v.length > 1));
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

/** Fills {first_name}-style placeholders in a script. Unknown or empty ones become a blank line marker. */
export function fillScript(text: string, values: Record<string, string | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = values[k];
    return v ? v : k in values ? '____' : m;
  });
}
