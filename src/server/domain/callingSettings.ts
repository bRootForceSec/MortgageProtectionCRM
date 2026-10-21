import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { DomainError } from '../core/errors.js';
import { CallingSettings, SHORTCUT_ACTIONS } from '../../shared/callingSettings.js';

// Loads and saves the Calling screen settings (the schema is in src/shared/callingSettings.ts).

export function loadCallingSettings(db: DB): CallingSettings {
  const raw = getSetting<unknown>(db, 'calling') ?? {};
  const r = CallingSettings.safeParse(raw);
  // A bad stored value never blocks calling: fall back to defaults.
  return r.success ? r.data : CallingSettings.parse({});
}

export function saveCallingSettings(db: DB, input: unknown): CallingSettings {
  const s = CallingSettings.parse(input);
  for (const a of Object.keys(s.shortcuts.actions)) {
    if (!(a in SHORTCUT_ACTIONS)) throw new DomainError(`unknown shortcut action "${a}"`);
  }
  setSetting(db, 'calling', s);
  return s;
}

export function retryGapMs(db: DB): number {
  return loadCallingSettings(db).retry_gap_minutes * 60_000;
}
