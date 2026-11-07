import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { DomainError } from '../core/errors.js';
import { FunnelSteps, STARTER_FUNNEL, stepFormula, type FunnelStepDef } from '../../shared/funnel.js';
import { FormulaError } from '../../shared/formula.js';
import { funnelStepSql } from './formulas.js';

// Your funnel steps (the setting `funnel_steps`; shapes in src/shared/funnel.ts) and what your own formula steps
// count for a period. The seven counts the CRM keeps itself are worked out in todayStats.

export function loadFunnelSteps(db: DB): FunnelStepDef[] {
  const r = FunnelSteps.safeParse(getSetting<unknown>(db, 'funnel_steps') ?? STARTER_FUNNEL);
  // A bad stored value never blocks the top bar: fall back to the seven.
  return r.success ? r.data : STARTER_FUNNEL;
}

export function saveFunnelSteps(db: DB, input: unknown): FunnelStepDef[] {
  const steps = FunnelSteps.parse(input);
  const names = new Set<string>();
  for (const st of steps) {
    const key = st.name.toLowerCase();
    if (names.has(key)) throw new DomainError(`two funnel steps are called "${st.name}"`);
    names.add(key);
    const formula = stepFormula(st.count);
    if (formula == null) continue;
    try {
      funnelStepSql(db, formula);
    } catch (e) {
      if (e instanceof FormulaError) throw new DomainError(`Funnel step "${st.name}": ${e.message}`);
      throw e;
    }
  }
  setSetting(db, 'funnel_steps', steps);
  return steps;
}

/**
 * What each of your formula steps counts from `from` to `to` (ISO times), by step id: the sum over your leads (those
 * `group` lets through, over `lead l`).
 * A step whose formula has gone wrong since (a field it names was deleted) counts 0.
 */
export function funnelFormulaCounts(
  db: DB, from: string, to: string, steps = loadFunnelSteps(db), group: { sql: string; params: Record<string, unknown> } = { sql: '1', params: {} },
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const st of steps) {
    const formula = stepFormula(st.count);
    if (formula == null) continue;
    let sql: string;
    try {
      sql = funnelStepSql(db, formula);
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      out[st.id] = 0;
      continue;
    }
    const r = db
      .prepare(`SELECT coalesce(SUM(${sql}), 0) n FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE ${group.sql}`)
      .get({ ...group.params, fw_from: from, fw_to: to }) as { n: number };
    out[st.id] = Math.round(Number(r.n) * 100) / 100;
  }
  return out;
}
