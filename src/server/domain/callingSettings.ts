import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../ai/settings.js';

// Settings for the Calling screen. You set every limit yourself; nothing here caps how much you call.

/** Actions that have keyboard shortcuts. Outcome keys are set per outcome. */
export const SHORTCUT_ACTIONS = {
  dial: { label: 'Dial / copy the number and start the timer', keys: ['c'] },
  dial_alt: { label: 'Dial the lead\'s other number', keys: ['x'] },
  dials_up: { label: 'One more dial', keys: ['ArrowRight', '>', '.'] },
  dials_down: { label: 'One less dial', keys: ['ArrowLeft', '<', ','] },
  list_down: { label: 'Move down the list', keys: ['ArrowDown'] },
  list_up: { label: 'Move up the list', keys: ['ArrowUp'] },
  next: { label: 'Next lead you haven\'t worked yet', keys: ['n'] },
  skip: { label: 'Skip this lead', keys: ['s'] },
  undo: { label: 'Undo the last saved call (10 seconds)', keys: ['z'] },
  note: { label: 'Write a note', keys: ['a'] },
  search: { label: 'Search', keys: ['/'] },
  edit: { label: 'Edit the lead', keys: ['e'] },
  script: { label: 'Show or hide the script', keys: ['p'] },
  lookup: { label: 'Look up an incoming caller by number', keys: ['l'] },
  called_back: { label: 'Mark (or unmark) that this lead called you back', keys: ['b'] },
} as const;
export type ShortcutAction = keyof typeof SHORTCUT_ACTIONS;

const key = z.string().min(1).max(20);

export const CallingSettings = z.object({
  /** Minutes before an unanswered lead comes back. 0 means right away. */
  retry_gap_minutes: z.number().int().min(0).max(60 * 24 * 60).default(240),
  /** From this hour on, a new appointment or callback defaults to tomorrow morning instead of today. */
  late_cutoff_hour: z.number().int().min(0).max(24).default(21),
  /** How "dial" works: copy the number, show a QR code for your phone, or send it to your phone with KDE Connect. */
  dial_method: z.enum(['copy', 'qr', 'kdeconnect']).default('copy'),
  kdeconnect_device: z.string().max(100).nullable().default(null),
  /** Fill talk minutes from the timer when you save. */
  use_timer: z.boolean().default(true),
  /** No answer and Bad number save as soon as you press the key, without Enter. */
  instant_save: z.boolean().default(true),
  /** With KDE Connect, send the next lead's number to your phone as soon as you save or skip. */
  auto_send_next: z.boolean().default(true),
  shortcuts: z
    .object({
      actions: z.record(z.string(), z.array(key).max(5)).default({}),
      /** outcome code -> key */
      outcomes: z.record(z.string(), key.nullable()).default({}),
    })
    .default({ actions: {}, outcomes: {} }),
  scripts: z
    .object({
      agent_name: z.string().max(100).default(''),
      opener: z.string().max(5000).default(''),
      voicemail: z.string().max(5000).default(''),
    })
    .default({ agent_name: '', opener: '', voicemail: '' }),
  goals: z
    .object({
      dials: z.number().int().min(0).max(100000).nullable().default(null),
      contacts: z.number().int().min(0).max(100000).nullable().default(null),
      appointments: z.number().int().min(0).max(10000).nullable().default(null),
    })
    .default({ dials: null, contacts: null, appointments: null }),
  alerts: z
    .object({
      desktop: z.boolean().default(true),
      sound: z.boolean().default(true),
      minutes_before: z.number().int().min(0).max(120).default(0),
    })
    .default({ desktop: true, sound: true, minutes_before: 0 }),
});
export type CallingSettings = z.infer<typeof CallingSettings>;

export function loadCallingSettings(db: DB): CallingSettings {
  const raw = getSetting<unknown>(db, 'calling') ?? {};
  const r = CallingSettings.safeParse(raw);
  // A bad stored value never blocks calling: fall back to defaults.
  return r.success ? r.data : CallingSettings.parse({});
}

export function saveCallingSettings(db: DB, input: unknown): CallingSettings {
  const s = CallingSettings.parse(input);
  for (const a of Object.keys(s.shortcuts.actions)) {
    if (!(a in SHORTCUT_ACTIONS)) throw new Error(`unknown shortcut action "${a}"`);
  }
  setSetting(db, 'calling', s);
  return s;
}

export function retryGapMs(db: DB): number {
  return loadCallingSettings(db).retry_gap_minutes * 60_000;
}
