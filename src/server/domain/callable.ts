import type { DB } from '../db/connection.js';
import { sqlList } from '../db/sql.js';
import { CALLABLE_STATUSES } from '../../shared/leadStatus.js';
import { STARTER_CALLABLE } from '../../shared/callingSettings.js';
import { FormulaError } from '../../shared/formula.js';
import { loadCallingSettings } from './callingSettings.js';
import { conditionSql } from './formulas.js';

// Which leads can go on the call list and be dialed: your "Can be called when" condition (Settings → Calling,
// `callable_when`), never a lead in the dead pile or with no good number. The call list, rules, the Leads
// page and the counts of leads left to call all read it from here.

/** SQL over `lead l JOIN lead_state s`: the lead can be called. */
export function callableSql(db: DB): string {
  const floor = `s.status IN ${sqlList(CALLABLE_STATUSES)}`;
  const cond = loadCallingSettings(db).callable_when;
  if (!cond) return floor;
  try {
    return `(${floor} AND ${conditionSql(db, cond)})`;
  } catch (e) {
    // It was checked when saved, so this is a tag or field it names that has since gone: calling carries on as you started.
    if (e instanceof FormulaError) return `(${floor} AND ${conditionSql(db, STARTER_CALLABLE)})`;
    throw e;
  }
}

/** Which of these leads can be called. */
export function callableIds(db: DB, leadIds: string[]): Set<string> {
  if (!leadIds.length) return new Set();
  const rows = db
    .prepare(`SELECT l.id FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE l.id IN (SELECT value FROM json_each(?)) AND ${callableSql(db)}`)
    .all(JSON.stringify(leadIds)) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}
