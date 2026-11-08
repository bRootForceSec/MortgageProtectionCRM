import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { DomainError } from '../core/errors.js';
import { conditionSql, loadStatusDefs } from './formulas.js';
import { saveStatuses } from './statuses.js';
import { uuidv7 } from '../ids.js';
import { ensureTag, setTagOnLeads, tagByName } from './tags.js';
import { CURRENT_OUTCOME } from '../db/sql.js';
import { leadCustomValues, listCustomFields, setCustomValues } from './customFields.js';
import { isTypedField } from '../../shared/customFields.js';
import { loadOutcomeOverrides, saveOutcomeOverrides } from './callingSettings.js';
import { APPOINTMENT_LIST, ButtonDef, ButtonDefs, buttonSide, starterButtons, starterShowWhen, type ButtonInfo } from '../../shared/buttons.js';
import { OUTCOMES, outcomeDef, type OutcomeCode, type OutcomeOverrides } from '../../shared/outcomes.js';

// Your Calling screen buttons (shared/buttons.ts), kept as the `buttons` setting. An outcome's own button keeps its
// name and "shown" in `outcome_overrides` (so Reports and older calls follow a rename, as before); everything else
// about a button is stored here. With nothing stored, every outcome has its own button, as it always had.

/** As stored: an outcome's own button leaves out its name and "shown". */
const Stored = z.array(ButtonDef.extend({ label: ButtonDef.shape.label.optional(), hidden: z.boolean().optional() }));

const isOwn = (b: { id: string; outcome: string }) => b.id === b.outcome;

/** Every button, in your order: the ones you set up, then any outcome's own button not in that list yet. */
export function loadButtons(db: DB): ButtonInfo[] {
  const over = loadOutcomeOverrides(db);
  const label = (c: string) => over[c]?.label ?? outcomeDef(c)?.label ?? c;
  const offered = (c: string) => over[c]?.offered ?? outcomeDef(c)?.offered ?? true;
  // A bad stored value never blocks calling: the outcomes' own buttons still show.
  const r = Stored.safeParse(getSetting<unknown>(db, 'buttons') ?? []);
  const seen = new Set<string>();
  const out: ButtonDef[] = [];
  for (const b of r.success ? r.data : []) {
    if (seen.has(b.id) || !outcomeDef(b.outcome)?.active) continue;
    if (isOwn(b)) out.push({ ...b, label: label(b.id), hidden: !offered(b.id) });
    else if (b.label && !outcomeDef(b.id)) out.push({ ...b, label: b.label, hidden: b.hidden ?? false });
    else continue;
    seen.add(b.id);
  }
  for (const b of starterButtons(label, offered)) if (!seen.has(b.id)) out.push(b);
  // A tag or field deleted since is left out, so the button still saves.
  const tags = new Set((db.prepare('SELECT id FROM tag').all() as { id: string }[]).map((t) => t.id));
  const fields = new Set(listCustomFields(db).filter(isTypedField).map((f) => f.id));
  return out.map((b) => ({
    ...b, add_tags: b.add_tags.filter((t) => tags.has(t)), remove_tags: b.remove_tags.filter((t) => tags.has(t)), asks: b.asks.filter((f) => fields.has(f)),
    side: buttonSide(b), own: isOwn(b), default_key: isOwn(b) ? OUTCOMES[b.id as OutcomeCode].hotkey : null,
  }));
}

/** One button, or a DomainError when it's gone. */
export function buttonById(db: DB, id: string): ButtonInfo {
  const b = loadButtons(db).find((x) => x.id === id);
  if (!b) throw new DomainError('that button is gone: reload the page and pick another');
  return b;
}

/**
 * Saves your buttons, in order. Each one counts as an active outcome, has a name no other button has, and a show-when
 * condition that works; the tags it adds or takes off exist. An outcome's own button can be hidden but not deleted
 * (it comes back at the end), and each side of the Calling screen keeps at least one button.
 */
export function saveButtons(db: DB, input: unknown): ButtonInfo[] {
  const list = ButtonDefs.parse(input);
  const ids = new Set<string>();
  const names = new Map<string, string>();
  const tagExists = db.prepare('SELECT 1 FROM tag WHERE id = ?');
  const fields = new Map(listCustomFields(db).map((f) => [f.id, f]));
  for (const b of list) {
    if (ids.has(b.id)) throw new DomainError('two buttons have the same id');
    ids.add(b.id);
    const def = outcomeDef(b.outcome);
    if (!def?.active) throw new DomainError(`${b.label}: pick what it counts as`);
    if (outcomeDef(b.id) && !isOwn(b)) throw new DomainError(`${b.label}: that id belongs to an outcome`);
    const key = b.label.toLowerCase();
    if (names.has(key)) throw new DomainError(`two buttons are called "${b.label}"`);
    names.set(key, b.id);
    if (b.show_when) {
      try {
        conditionSql(db, b.show_when);
      } catch (e) {
        throw new DomainError(`${b.label}, show when: ${(e as Error).message}`);
      }
    }
    for (const t of [...b.add_tags, ...b.remove_tags]) if (!tagExists.get(t)) throw new DomainError(`${b.label}: one of its tags is gone`);
    if (b.add_tags.some((t) => b.remove_tags.includes(t))) throw new DomainError(`${b.label}: it can't add and take off the same tag`);
    for (const id of b.asks) {
      const f = fields.get(id);
      if (!f) throw new DomainError(`${b.label}: one of the fields it asks for is gone`);
      if (!isTypedField(f)) throw new DomainError(`${b.label}: ${f.label} is ${f.type === 'counter' ? 'a counter' : 'a formula'}, so a button can't ask for it`);
    }
  }
  const overrides: OutcomeOverrides = { ...loadOutcomeOverrides(db) };
  for (const b of list) if (isOwn(b)) overrides[b.id] = { label: b.label, offered: !b.hidden };
  db.transaction(() => {
    saveOutcomeOverrides(db, overrides, { checkSides: false });
    setSetting(db, 'buttons', list.map((b) => (isOwn(b) ? { ...b, label: undefined, hidden: undefined } : b)));
  })();
  return loadButtons(db);
}

/** The smart list that says a lead has an appointment to log, which the appointment buttons show for. */

/**
 * Once, after the update that took away the First call and Appointment sides: each button shows by a condition instead.
 * A smart list "Has an appointment" (the rule the sides used: an appointment set that hasn't sold) is added if there
 * isn't one; appointment buttons show for leads in it and the others for leads not in it, each joined to any show-when
 * condition it had. You can change the smart list, or any button's condition, like anything else.
 */
export function sidesToConditions(db: DB): boolean {
  if (getSetting<boolean>(db, 'sides_to_conditions_done')) return false;
  db.transaction(() => {
    const lists = loadStatusDefs(db);
    if (!lists.some((st) => st.name.toLowerCase() === APPOINTMENT_LIST.toLowerCase())) {
      saveStatuses(db, [...lists, { id: uuidv7(), name: APPOINTMENT_LIST, condition: 'status == "appointment_set" and ifblank(appt_result, "") != "sold"', color: 'blue', tab: false }]);
    }
    const cond = (b: ButtonInfo) => {
      const side = starterShowWhen(b.outcome);
      return !b.show_when ? side : b.show_when === side ? side : `${side} and (${b.show_when})`;
    };
    saveButtons(db, loadButtons(db).map((b) => ButtonDef.parse({ ...b, show_when: cond(b) })));
    setSetting(db, 'sides_to_conditions_done', true);
  })();
  return true;
}

/** The buttons this lead doesn't get now, because their show-when condition is false for it. */
export function buttonsHiddenFor(db: DB, leadId: string): string[] {
  const conditional = loadButtons(db).filter((b) => b.show_when && !b.hidden);
  if (!conditional.length) return [];
  const flags = conditional.map((b) => {
    try {
      return `CASE WHEN ${conditionSql(db, b.show_when)} THEN 1 ELSE 0 END`;
    } catch {
      // A condition that stopped working (a status was deleted...) shows the button rather than hiding it.
      return '1';
    }
  });
  const r = db.prepare(`SELECT json_array(${flags.join(', ')}) f FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE l.id = ?`).get(leadId) as { f: string } | undefined;
  const on = r ? (JSON.parse(r.f) as number[]) : [];
  return conditional.filter((_, i) => on[i] === 0).map((b) => b.id);
}

/**
 * The values a button asked for, saved with its call. Only the fields it asks for; one that's needed for this lead now
 * (its needed-when condition) can't be left blank.
 */
export function saveAskedFields(db: DB, b: ButtonInfo | null, leadId: string, values: Record<string, string | null>, now: string) {
  const extra = Object.keys(values).find((id) => !b?.asks.includes(id));
  if (extra) throw new DomainError(b ? `${b.label} doesn't ask for that field` : 'only a button that asks for a field saves one with the call');
  if (!b?.asks.length) return;
  for (const f of leadCustomValues(db, leadId)) {
    if (!b.asks.includes(f.field_id) || !f.required) continue;
    const v = Object.hasOwn(values, f.field_id) ? values[f.field_id] : f.value;
    if (!v?.trim()) throw new DomainError(`${f.label} is needed for this lead`);
  }
  setCustomValues(db, leadId, values, now);
}

/**
 * What pressing a button does to the lead's tags, logged with the button and the call (so undoing the call undoes it):
 * its own tag (its name) replacing the last button's, then the tags it takes off and adds.
 */
export function pressButtonTags(db: DB, b: ButtonInfo, leadId: string, callId: string, now: string) {
  const by = { source: 'button', id: b.id, name: b.label, call_id: callId } as const;
  if (b.tag_self) putOwnTag(db, b, leadId, callId, now);
  for (const t of b.remove_tags) setTagOnLeads(db, [leadId], t, false, now, by);
  for (const t of b.add_tags) setTagOnLeads(db, [leadId], t, true, now, by);
}

/** Puts the button's own tag on the lead, taking off any other button's own tag. */
function putOwnTag(db: DB, b: ButtonInfo, leadId: string, callId: string, now: string) {
  const by = { source: 'button', id: b.id, name: b.label, call_id: callId } as const;
  const own = ensureTag(db, b.label, now);
  for (const t of outcomeTagIds(db)) if (t !== own.id) setTagOnLeads(db, [leadId], t, false, now, by);
  setTagOnLeads(db, [leadId], own.id, true, now, by);
}

/** A call's outcome was changed: when it's the lead's latest call, the lead gets the new outcome's own tag instead. */
export function retagChangedOutcome(db: DB, callId: string, leadId: string, outcomeCode: string, now: string) {
  const latest = db.prepare('SELECT id FROM call WHERE lead_id = ? AND voided_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1').get(leadId) as { id: string } | undefined;
  if (latest?.id !== callId) return;
  const b = loadButtons(db).find((x) => x.id === outcomeCode);
  if (b?.tag_self) putOwnTag(db, b, leadId, callId, now);
}

/** The tags buttons put on with their own name (the ones that exist), which replace each other. */
function outcomeTagIds(db: DB): string[] {
  return loadButtons(db).filter((b) => b.tag_self).map((b) => tagByName(db, b.label)?.id).filter((t): t is string => !!t);
}

/**
 * Once: every lead gets the tag of the button its latest call was saved with (the outcome's name for calls from before
 * buttons), so smart lists built on those tags see your older leads too. Logged as by that button, "from past calls".
 */
export function tagLeadsWithLastButton(db: DB, now: string): number {
  if (getSetting<boolean>(db, 'outcome_tags_done')) return 0;
  const buttons = new Map(loadButtons(db).map((b) => [b.id, b]));
  const rows = db
    .prepare(
      `SELECT c.lead_id, o.outcome_code, o.button_id FROM call c JOIN call_outcome o ON o.call_id = c.id
       WHERE c.voided_at IS NULL AND c.lead_id IS NOT NULL AND ${CURRENT_OUTCOME}
         AND c.started_at = (SELECT max(c2.started_at) FROM call c2 WHERE c2.lead_id = c.lead_id AND c2.voided_at IS NULL)`,
    )
    .all() as { lead_id: string; outcome_code: string; button_id: string | null }[];
  let n = 0;
  db.transaction(() => {
    const done = new Set<string>();
    for (const r of rows) {
      if (done.has(r.lead_id)) continue;
      done.add(r.lead_id);
      const b = buttons.get(r.button_id ?? r.outcome_code) ?? buttons.get(r.outcome_code);
      if (!b?.tag_self) continue;
      n += setTagOnLeads(db, [r.lead_id], ensureTag(db, b.label, now).id, true, now, { source: 'button', id: b.id, name: `${b.label}, from past calls` });
    }
    setSetting(db, 'outcome_tags_done', true);
  })();
  return n;
}

/** Undoes what a call's button did to tags, newest first. A tag that was deleted since is left alone. */
export function undoButtonTags(db: DB, callId: string, now: string) {
  const lines = db
    .prepare(
      `SELECT e.lead_id, e.kind, e.tag_id, e.source_id, e.source_name FROM lead_event e JOIN tag t ON t.id = e.tag_id
       WHERE e.call_id = ? AND e.source = 'button' ORDER BY e.at DESC, e.id DESC`,
    )
    .all(callId) as { lead_id: string; kind: string; tag_id: string; source_id: string | null; source_name: string | null }[];
  for (const l of lines) {
    setTagOnLeads(db, [l.lead_id], l.tag_id, l.kind === 'tag_removed', now, { source: 'button', id: l.source_id, name: `${l.source_name ?? 'a button'}, undone`, call_id: callId });
  }
}
