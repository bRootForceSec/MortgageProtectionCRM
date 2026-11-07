import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { DomainError } from '../core/errors.js';
import { nowIso, uuidv7 } from '../ids.js';
import { sqlList } from '../db/sql.js';
import { CALLABLE_STATUSES } from '../../shared/leadStatus.js';
import { LeadQuery } from '../../shared/leadFilter.js';
import { Routines, routinesOn, starterRoutine, type Routine, type RoutineStep, type RoutineToday, type StepOrder } from '../../shared/routines.js';
import { addToCallList, clearCallList, loadSavedList, matchingLeadIds, toLeadFilter, WORKED, type AddResult } from './callList.js';

// Daily routines (shared/routines.ts): stored as one setting, plus a note of which steps you started today and with
// which leads, so the Calling screen can show how far each one got. That note starts fresh each day.

const ROUTINES = 'routines';
const DAY = 'routine_day';

interface RoutineDay {
  day: string;
  /** The routine you picked for today, when it isn't the first one for the weekday. */
  routine_id: string | null;
  started: Record<string, { at: string; lead_ids: string[] }>;
}

/** YYYY-MM-DD on this computer. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function loadRoutines(db: DB): Routine[] {
  const raw = getSetting<unknown>(db, ROUTINES);
  if (raw == null) {
    // First time: the routine you described, saved so its steps keep their ids.
    const starter = [starterRoutine(uuidv7)];
    setSetting(db, ROUTINES, starter);
    return starter;
  }
  const r = Routines.safeParse(raw);
  // A bad stored value never blocks calling: no routine until it's saved again.
  return r.success ? r.data : [];
}

export function saveRoutines(db: DB, input: unknown): Routine[] {
  const r = Routines.parse(input);
  const ids = r.flatMap((x) => [x.id, ...x.steps.map((s) => s.id)]);
  if (new Set(ids).size !== ids.length) throw new DomainError('two routines or steps have the same id');
  setSetting(db, ROUTINES, r);
  return r;
}

function loadDay(db: DB, today: string): RoutineDay {
  const d = getSetting<RoutineDay>(db, DAY);
  return d && d.day === today ? d : { day: today, routine_id: null, started: {} };
}

/** The leads a step would put on the list: callable ones, in the step's own order (file order, or the saved list's). */
function stepLeadIds(db: DB, step: RoutineStep, now: Date): string[] | null {
  const ids =
    step.source.kind === 'filter'
      ? matchingLeadIds(db, toLeadFilter(LeadQuery.parse(step.source.filter), now))
      : savedListLeadIds(db, step.source.list_id);
  if (!ids) return null;
  if (!ids.length) return [];
  const callable = new Set(
    (db.prepare(`SELECT lead_id FROM lead_state WHERE status IN ${sqlList(CALLABLE_STATUSES)} AND lead_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as { lead_id: string }[]).map((r) => r.lead_id),
  );
  return ids.filter((id) => callable.has(id));
}

function savedListLeadIds(db: DB, listId: string): string[] | null {
  if (!db.prepare('SELECT 1 FROM saved_call_list WHERE id = ?').get(listId)) return null;
  return (db.prepare('SELECT lead_id FROM saved_call_list_item WHERE list_id = ? ORDER BY position').all(listId) as { lead_id: string }[]).map((r) => r.lead_id);
}

function waitingOnList(db: DB): Set<string> {
  return new Set(
    (db.prepare(`SELECT i.lead_id FROM call_list_item i WHERE NOT ${WORKED}`).all() as { lead_id: string }[]).map((r) => r.lead_id),
  );
}

export function routineToday(db: DB, now = new Date()): RoutineToday {
  const routines = loadRoutines(db);
  const today = localDay(now);
  const state = loadDay(db, today);
  const todays = routinesOn(routines, now.getDay());
  const routine = routines.find((r) => r.id === state.routine_id) ?? todays[0] ?? null;
  const waiting = waitingOnList(db);
  const calledSince = db.prepare('SELECT COUNT(DISTINCT lead_id) n FROM call WHERE voided_at IS NULL AND requested_at >= ? AND lead_id IN (SELECT value FROM json_each(?))');
  return {
    day: today,
    routine: routine && { id: routine.id, name: routine.name },
    choices: routines.map((r) => ({ id: r.id, name: r.name, today: todays.includes(r) })),
    steps: (routine?.steps ?? []).map((s) => {
      const ids = stepLeadIds(db, s, now);
      const started = state.started[s.id] ?? null;
      return {
        id: s.id,
        name: s.name,
        order: s.order,
        kind: s.source.kind,
        count: ids ? ids.filter((id) => !waiting.has(id)).length : null,
        appt_days: s.source.kind === 'filter' ? s.source.filter.appt_days ?? null : null,
        started_at: started?.at ?? null,
        total: started?.lead_ids.length ?? 0,
        called: started ? (calledSince.get(started.at, JSON.stringify(started.lead_ids)) as { n: number }).n : 0,
      };
    }),
  };
}

/** Picks the routine for today (any of them, whatever its days). */
export function chooseRoutine(db: DB, routineId: string, now = new Date()): RoutineToday {
  if (!loadRoutines(db).some((r) => r.id === routineId)) throw new DomainError('that routine is gone', 404);
  setSetting(db, DAY, { ...loadDay(db, localDay(now)), routine_id: routineId });
  return routineToday(db, now);
}

/**
 * Starts a step of today's routine: its leads go under the call list, or replace it (saving the current list first
 * under `saveCurrentAs` when given). A saved-list step that replaces the list loads that list, so Save writes back to it.
 */
export function startStep(
  db: DB,
  stepId: string,
  mode: 'add' | 'replace',
  saveCurrentAs: string | null,
  now = new Date(),
): AddResult & { order: StepOrder } {
  const today = routineToday(db, now);
  const step = loadRoutines(db).find((r) => r.id === today.routine?.id)?.steps.find((s) => s.id === stepId);
  if (!step) throw new DomainError("that step isn't in today's routine", 404);
  const at = nowIso();
  return db.transaction(() => {
    const ids = stepLeadIds(db, step, now);
    if (!ids) throw new DomainError('the saved list for this step is gone; pick another in Settings', 409);
    let res: AddResult;
    if (mode === 'replace' && step.source.kind === 'saved_list') {
      loadSavedList(db, step.source.list_id, saveCurrentAs, at);
      res = { added: ids.length, already: 0, not_callable: 0, skipped: [] };
    } else {
      if (mode === 'replace') clearCallList(db, saveCurrentAs, at);
      res = addToCallList(db, ids, at);
    }
    // A step with nothing to call yet stays "next" (no-answers fill in as the day goes).
    if (ids.length) {
      const state = loadDay(db, today.day);
      setSetting(db, DAY, { ...state, routine_id: today.routine!.id, started: { ...state.started, [step.id]: { at, lead_ids: ids } } });
    }
    return { ...res, order: step.order };
  })();
}
