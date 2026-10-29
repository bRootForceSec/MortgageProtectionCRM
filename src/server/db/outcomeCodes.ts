import type { DB } from './connection.js';
import { sqlList } from './sql.js';
import { OUTCOMES, outcomeCodes, type OutcomeDef } from '../../shared/outcomes.js';

// The outcome_code table is a copy of the registry in src/shared/outcomes.ts, so SQL can join on it. It is brought
// in line after the migrations run, each time the database opens. Rows are never deleted: calls reference them.

/** The outcome_code row for a registry entry. */
export function outcomeRow(code: string, o: OutcomeDef) {
  return {
    code,
    label: o.label,
    grp: o.group,
    kind: o.kind,
    hotkey: o.hotkey,
    counts_as_human_contact: o.pickup ? 1 : 0,
    requires_callback_time: o.callback ? 1 : 0,
    marks_dead: o.marksDead ? 1 : 0,
    sort_order: o.sortOrder,
    active: o.active ? 1 : 0,
    lead_effect: o.leadEffect,
    introduced_at: o.introducedAt,
    retired_at: null,
  };
}

/** Inserts or updates outcome_code so it matches the registry. Returns how many rows changed. */
export function syncOutcomeCodes(db: DB): number {
  const up = db.prepare(
    `INSERT INTO outcome_code (code, label, grp, kind, hotkey, counts_as_human_contact, requires_callback_time, marks_dead, sort_order, active, lead_effect, introduced_at, retired_at)
     VALUES (@code, @label, @grp, @kind, @hotkey, @counts_as_human_contact, @requires_callback_time, @marks_dead, @sort_order, @active, @lead_effect, @introduced_at, @retired_at)
     ON CONFLICT(code) DO UPDATE SET label = excluded.label, grp = excluded.grp, kind = excluded.kind, hotkey = excluded.hotkey,
       counts_as_human_contact = excluded.counts_as_human_contact, requires_callback_time = excluded.requires_callback_time,
       marks_dead = excluded.marks_dead, sort_order = excluded.sort_order, active = excluded.active, lead_effect = excluded.lead_effect
     WHERE (outcome_code.label, outcome_code.grp, outcome_code.kind, outcome_code.hotkey, outcome_code.counts_as_human_contact,
            outcome_code.requires_callback_time, outcome_code.marks_dead, outcome_code.sort_order, outcome_code.active, outcome_code.lead_effect)
       IS NOT (excluded.label, excluded.grp, excluded.kind, excluded.hotkey, excluded.counts_as_human_contact,
            excluded.requires_callback_time, excluded.marks_dead, excluded.sort_order, excluded.active, excluded.lead_effect)`,
  );
  return db.transaction(() => {
    let changed = 0;
    for (const [code, o] of Object.entries(OUTCOMES)) changed += up.run(outcomeRow(code, o)).changes;
    return changed;
  })();
}

/** An SQL list of the codes for which `test` holds, e.g. `('appointment')`. The codes are fixed strings, never input. */
export function sqlCodes(test: (o: OutcomeDef) => boolean): string {
  return sqlList(outcomeCodes(test));
}
