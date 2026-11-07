import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { audit } from '../core/audit.js';
import { normalizeCustomValue, type CustomField, type CustomFieldInput } from '../../shared/customFields.js';
import { FormulaError, formulaFieldLabels, parseFormula, renameFormulaField } from '../../shared/formula.js';
import { compileFormula, formulaResults, syncFieldValueView } from './formulas.js';

// Custom fields: fields you add to every lead. Defining them is audited; a value typed on a lead is kept in the lead's
// change history (lead_change, under the field's name) like any other edit.

interface FieldRow { id: string; label: string; type: CustomField['type']; options_json: string | null; formula: string | null; sort_order: number; leads: number }

/** `leads` counts typed values: a formula field has none of its own. */
export function listCustomFields(db: DB): CustomField[] {
  const rows = db
    .prepare('SELECT f.*, (SELECT COUNT(*) FROM lead_custom_value v WHERE v.field_id = f.id) leads FROM custom_field f ORDER BY f.sort_order, f.created_at')
    .all() as FieldRow[];
  const results = formulaResults(rows);
  return rows.map((r) => ({
    id: r.id, label: r.label, type: r.type, options: r.options_json ? (JSON.parse(r.options_json) as string[]) : [], sort_order: r.sort_order, leads: r.leads,
    formula: r.type === 'formula' ? r.formula : null, result: results.get(r.id) ?? null,
  }));
}

function getField(db: DB, id: string): CustomField {
  const f = listCustomFields(db).find((x) => x.id === id);
  if (!f) throw new DomainError('that field is gone', 404);
  return f;
}

/** The formula fields that use this field (by name), other than itself. */
function usedBy(db: DB, f: Pick<CustomField, 'id' | 'label'>): string[] {
  return listCustomFields(db)
    .filter((x) => x.type === 'formula' && x.id !== f.id && formulaUses(x.formula, f.label))
    .map((x) => x.label);
}

function formulaUses(formula: string | null, label: string): boolean {
  try {
    return formulaFieldLabels(parseFormula(formula ?? '')).some((l) => l.toLowerCase() === label.toLowerCase());
  } catch {
    return false;
  }
}

function checkInput(db: DB, b: CustomFieldInput, id: string | null): string | null {
  const clash = db.prepare('SELECT id FROM custom_field WHERE label = ?').get(b.label) as { id: string } | undefined;
  if (clash && clash.id !== id) throw new DomainError(`there is already a field called "${b.label}"`, 409);
  if (/[[\]]/.test(b.label)) throw new DomainError("a field name can't have [ or ] in it, so formulas can use it");
  if (b.type === 'formula') {
    try {
      const fields = (db.prepare('SELECT id, label, type, formula FROM custom_field').all() as CustomField[]).filter((f) => f.id !== id);
      compileFormula(b.formula ?? '', [...fields, { id: id ?? '(new)', label: b.label, type: 'formula', formula: b.formula ?? '' } as CustomField], id ?? '(new)');
    } catch (e) {
      if (e instanceof FormulaError) throw new DomainError(`${b.label}: ${e.message}`);
      throw e;
    }
  }
  if (b.type !== 'choice') return null;
  // The same choice typed twice (any case) is kept once, as first typed.
  const seen = new Set<string>();
  const options = (b.options ?? []).filter((o) => !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
  if (!options.length) throw new DomainError('give the list at least one choice');
  return JSON.stringify(options);
}

export function createCustomField(db: DB, b: CustomFieldInput, now = nowIso()): CustomField {
  return db.transaction(() => {
    const options = checkInput(db, b, null);
    const id = uuidv7();
    const order = (db.prepare('SELECT coalesce(max(sort_order), 0) + 1 n FROM custom_field').get() as { n: number }).n;
    db.prepare('INSERT INTO custom_field (id, label, type, options_json, formula, sort_order, created_at) VALUES (?,?,?,?,?,?,?)').run(
      id, b.label, b.type, options, b.type === 'formula' ? b.formula!.trim() : null, order, now,
    );
    audit(db, 'custom_field', id, 'insert', null, b, now);
    if (b.type === 'formula' || b.type === 'counter') syncFieldValueView(db);
    return getField(db, id);
  })();
}

/**
 * Renames a field, changes its choices or its formula. Its kind can change only while no lead has a value, so no value
 * turns invalid, and not while a formula uses it. A rename is carried into the formulas that use the field.
 */
export function updateCustomField(db: DB, id: string, b: CustomFieldInput): CustomField {
  return db.transaction(() => {
    const old = getField(db, id);
    if (b.type !== old.type && old.leads) throw new DomainError(`${old.leads} lead${old.leads === 1 ? ' has' : 's have'} a value in this field, so its kind can't change. Make a new field instead.`, 409);
    const users = usedBy(db, old);
    if (b.type !== old.type && users.length) throw new DomainError(`${users.join(', ')} use${users.length === 1 ? 's' : ''} this field in a formula, so its kind can't change`, 409);
    if (b.label !== old.label) {
      const set = db.prepare('UPDATE custom_field SET formula = ? WHERE id = ?');
      for (const f of listCustomFields(db)) if (f.type === 'formula' && f.id !== id && f.formula) set.run(renameFormulaField(f.formula, old.label, b.label), f.id);
    }
    const formula = b.type === 'formula' ? renameFormulaField(b.formula ?? '', old.label, b.label).trim() : null;
    const options = checkInput(db, { ...b, formula: formula ?? undefined }, id);
    db.prepare('UPDATE custom_field SET label = ?, type = ?, options_json = ?, formula = ? WHERE id = ?').run(b.label, b.type, options, formula, id);
    audit(db, 'custom_field', id, 'update', old, b);
    if ([b.type, old.type].some((t) => t === 'formula' || t === 'counter') || users.length) syncFieldValueView(db);
    return getField(db, id);
  })();
}

/** Moves a field one place up (-1) or down (1) in the order it shows on the lead. */
export function moveCustomField(db: DB, id: string, by: -1 | 1): CustomField[] {
  return db.transaction(() => {
    const list = listCustomFields(db);
    const i = list.findIndex((f) => f.id === id);
    if (i < 0) throw new DomainError('that field is gone', 404);
    const j = i + by;
    if (j < 0 || j >= list.length) return list;
    [list[i], list[j]] = [list[j]!, list[i]!];
    const set = db.prepare('UPDATE custom_field SET sort_order = ? WHERE id = ?');
    list.forEach((f, k) => set.run(k + 1, f.id));
    return listCustomFields(db);
  })();
}

/** Deletes a field and every lead's value in it. A field a formula uses can't be deleted. */
export function deleteCustomField(db: DB, id: string): { removed_from: number } {
  return db.transaction(() => {
    const old = getField(db, id);
    const users = usedBy(db, old);
    if (users.length) throw new DomainError(`${users.join(', ')} use${users.length === 1 ? 's' : ''} this field in a formula. Change ${users.length === 1 ? 'that formula' : 'those formulas'} first.`, 409);
    const n = db.prepare('DELETE FROM lead_custom_value WHERE field_id = ?').run(id).changes;
    db.prepare('DELETE FROM custom_field WHERE id = ?').run(id);
    audit(db, 'custom_field', id, 'delete', old, null);
    if (old.type === 'formula' || old.type === 'counter') syncFieldValueView(db);
    return { removed_from: n };
  })();
}

/** Every field with this lead's value (null when it has none), in order. Formula fields come worked out. */
export function leadCustomValues(db: DB, leadId: string): { field_id: string; label: string; type: CustomField['type']; result: CustomField['result']; options: string[]; value: string | null }[] {
  const values = new Map((db.prepare('SELECT field_id, value FROM lead_field_value WHERE lead_id = ?').all(leadId) as { field_id: string; value: unknown }[]).map((r) => [r.field_id, String(r.value)]));
  return listCustomFields(db).map((f) => ({ field_id: f.id, label: f.label, type: f.type, result: f.result, options: f.options, value: values.get(f.id) ?? null }));
}

/**
 * Sets this lead's values (field id → typed value; blank clears it). Returns how many changed. Call inside a transaction.
 * A counter is changed only by a rule (`counters: true`).
 */
export function setCustomValues(db: DB, leadId: string, values: Record<string, string | null>, now = nowIso(), opts: { counters?: boolean } = {}): number {
  const fields = new Map(listCustomFields(db).map((f) => [f.id, f]));
  const get = db.prepare('SELECT value FROM lead_custom_value WHERE lead_id = ? AND field_id = ?');
  const put = db.prepare('INSERT INTO lead_custom_value (lead_id, field_id, value, updated_at) VALUES (?,?,?,?) ON CONFLICT (lead_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  const del = db.prepare('DELETE FROM lead_custom_value WHERE lead_id = ? AND field_id = ?');
  const change = db.prepare('INSERT INTO lead_change (id, lead_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?)');
  let changed = 0;
  for (const [fieldId, raw] of Object.entries(values)) {
    const f = fields.get(fieldId);
    if (!f) throw new DomainError('that field is gone', 404);
    if (f.type === 'counter' && !opts.counters) throw new DomainError(`${f.label} is a counter: only rules change it`);
    let v: string | null;
    try {
      v = normalizeCustomValue(f, raw);
    } catch (e) {
      throw new DomainError((e as Error).message);
    }
    const old = (get.get(leadId, fieldId) as { value: string } | undefined)?.value ?? null;
    if (old === v) continue;
    if (v == null) del.run(leadId, fieldId);
    else put.run(leadId, fieldId, v, now);
    change.run(uuidv7(), leadId, f.label, old, v, now);
    changed++;
  }
  return changed;
}

