import * as z from 'zod/v4';
import { isStep } from './followUps.js';

// Calling screen settings, shared by the server (which validates and stores them) and the UI (which edits them).
// You set every limit yourself; nothing here caps how much you call.

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
  do_not_call: { label: 'Tick (or untick) "Do not call" for this call', keys: ['d'] },
  switch_mode: { label: 'Switch between First call and Appointment', keys: ['m'] },
} as const;
export type ShortcutAction = keyof typeof SHORTCUT_ACTIONS;

const key = z.string().min(1).max(20);
const plan = z.array(z.string().refine(isStep, 'not a follow-up step')).max(10).default([]);

export const CallingSettings = z.object({
  /** Minutes before an unanswered lead comes back. 0 means right away. */
  retry_gap_minutes: z.number().int().min(0).max(60 * 24 * 60).default(240),
  /** When to try again after a no-show, sat-no-sale or prezi (see followUps.ts). An empty plan means due right away. */
  follow_ups: z
    .object({
      no_show: plan,
      sat_no_sale: plan,
      prezi: plan,
    })
    .default({ no_show: [], sat_no_sale: [], prezi: [] }),
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
