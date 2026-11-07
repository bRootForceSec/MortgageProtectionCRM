import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { DomainError } from '../core/errors.js';
import { CallingSettings, SHORTCUT_ACTIONS } from '../../shared/callingSettings.js';
import type { FollowUpPlans } from '../../shared/followUps.js';
import { OUTCOMES, OutcomeOverrides, outcomeDef } from '../../shared/outcomes.js';
import { loadOutcomeOverrides, syncOutcomeCodes } from '../db/outcomeCodes.js';
import { conditionSql, sortStepSql } from './formulas.js';
import { FormulaError } from '../../shared/formula.js';

// Loads and saves the Calling screen settings (the schema is in src/shared/callingSettings.ts).

export function loadCallingSettings(db: DB): CallingSettings {
  const raw = getSetting<unknown>(db, 'calling') ?? {};
  const r = CallingSettings.safeParse(raw);
  // A bad stored value never blocks calling: fall back to defaults.
  const s = r.success ? r.data : CallingSettings.parse({});
  // Keys for an action that no longer exists (like the old script key) are dropped, so saving never trips on them.
  s.shortcuts.actions = Object.fromEntries(Object.entries(s.shortcuts.actions).filter(([a]) => a in SHORTCUT_ACTIONS));
  return s;
}

export function saveCallingSettings(db: DB, input: unknown): CallingSettings {
  const s = CallingSettings.parse(input);
  if (s.callable_when) {
    try {
      conditionSql(db, s.callable_when);
    } catch (e) {
      if (e instanceof FormulaError) throw new DomainError(`"Can be called when": ${e.message}`);
      throw e;
    }
  }
  s.list_order.forEach((step, n) => {
    if (step.by !== 'formula') return;
    try {
      sortStepSql(db, step.formula);
    } catch (e) {
      if (e instanceof FormulaError) throw new DomainError(`Call list order, step ${n + 1}: ${e.message}`);
      throw e;
    }
  });
  for (const a of Object.keys(s.shortcuts.actions)) {
    if (!(a in SHORTCUT_ACTIONS)) throw new DomainError(`unknown shortcut action "${a}"`);
  }
  setSetting(db, 'calling', s);
  return s;
}

export function retryGapMs(db: DB): number {
  return loadCallingSettings(db).retry_gap_minutes * 60_000;
}

export function followUpPlans(db: DB): FollowUpPlans {
  return loadCallingSettings(db).follow_ups;
}

/**
 * Saves your outcome names and buttons (Settings → Outcomes) and brings the outcome_code table in line. Only active
 * outcomes can be changed. A name or button that matches the default is not stored, so later default changes still
 * reach it. Each side of the Calling screen keeps at least one button.
 */
export function saveOutcomeOverrides(db: DB, input: unknown, opts: { checkSides?: boolean } = {}): OutcomeOverrides {
  const parsed = OutcomeOverrides.parse(input);
  const out: OutcomeOverrides = {};
  for (const [code, o] of Object.entries(parsed)) {
    const def = outcomeDef(code);
    if (!def || !def.active) throw new DomainError(`unknown outcome "${code}"`);
    const keep = {
      ...(o.label !== undefined && o.label !== def.label ? { label: o.label } : {}),
      ...(o.offered !== undefined && o.offered !== def.offered ? { offered: o.offered } : {}),
    };
    if (Object.keys(keep).length) out[code] = keep;
  }
  // Automation → Calling screen checks this itself, counting your own buttons too.
  for (const side of opts.checkSides === false ? [] : (['first_call', 'appointment'] as const)) {
    const shown = Object.entries(OUTCOMES).filter(([c, d]) => d.active && d.kind === side && (out[c]?.offered ?? d.offered));
    if (!shown.length) throw new DomainError(`keep at least one button on the ${side === 'appointment' ? 'Appointment' : 'First call'} side`);
  }
  db.transaction(() => {
    setSetting(db, 'outcome_overrides', out);
    syncOutcomeCodes(db);
  })();
  return out;
}

export { loadOutcomeOverrides };
