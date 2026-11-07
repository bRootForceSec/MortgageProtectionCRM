import type { DB } from '../db/connection.js';
import { CURRENT_OUTCOME, LEAD_NAME } from '../db/sql.js';
import { FORMULA_VALUES, FormulaError, parseFormula, type FormulaKind, type FormulaNode, type FormulaPreview } from '../../shared/formula.js';
import type { CustomField } from '../../shared/customFields.js';

// Formula fields (shared/formula.ts) are worked out by SQLite: each formula becomes an SQL expression over
// `lead l JOIN lead_state s`, and the view lead_field_value puts them next to the typed values. So filters, sorting,
// rules and the export read a formula like any other field, and it is always up to date (no stored copy to refresh).

type FieldDef = Pick<CustomField, 'id' | 'label' | 'type' | 'formula'>;
type Compiled = { sql: string; kind: FormulaKind };

/** A safe SQL text literal. */
const lit = (s: string) => `'${s.replace(/\0/g, '').replace(/'/g, "''")}'`;

const DAYS_SINCE = (t: string) => `CAST(julianday('now') - julianday(${t}) AS INTEGER)`;
const VALUE_SQL: Record<string, string> = {
  age: 'l.age',
  loan_amount: '(l.loan_amount_cents / 100.0)',
  attempts: 's.attempts_total',
  days_since_last_call: DAYS_SINCE('s.last_call_at'),
  lead_age_days: `max(0, ${DAYS_SINCE('l.callin_at')})`,
  days_since_imported: DAYS_SINCE('(SELECT ib.imported_at FROM import_batch ib WHERE ib.id = l.batch_id)'),
  lead_type: 'l.lead_type',
  status: 's.status',
  appt_result: 's.appt_result',
  state: 'l.state',
  has_coborrower: "(l.coborrower_signal = 'yes')",
};

/** The lead's log lines of `kind` for the tag named `name` (any case), in a query over `lead l`. */
const TAG_LINES = (kind: 'tag_added' | 'tag_removed', name: string) =>
  `FROM lead_event e WHERE e.lead_id = l.id AND e.kind = '${kind}' AND e.tag_id = (SELECT tt.id FROM tag tt WHERE tt.name = ${name})`;
/** "since N days ago", as a condition on an ISO time column. */
const WITHIN_DAYS = (col: string, days: string) => `${col} >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (${days}) || ' days')`;

const KIND_WORD: Record<FormulaKind, string> = { number: 'a number', text: 'text', yes_no: 'a yes/no', date: 'a date' };

/** Turns a formula into SQL, checking every name, field and kind. Throws FormulaError. */
function compile(n: FormulaNode, fields: Map<string, FieldDef>, using: string[]): Compiled {
  const c = (x: FormulaNode) => compile(x, fields, using);
  const want = (x: Compiled, kind: FormulaKind, where: string) => {
    if (x.kind !== kind) throw new FormulaError(`${where} needs ${KIND_WORD[kind]}, not ${KIND_WORD[x.kind]}`);
    return x.sql;
  };
  switch (n.t) {
    case 'num': return { sql: String(n.v), kind: 'number' };
    case 'str': return { sql: lit(n.v), kind: 'text' };
    case 'bool': return { sql: n.v ? '1' : '0', kind: 'yes_no' };
    case 'value': {
      const v = FORMULA_VALUES.find((x) => x.name === n.name);
      if (!v) throw new FormulaError(`there is no value called "${n.name}" (put your own fields in [ ])`);
      return { sql: VALUE_SQL[v.name]!, kind: v.kind };
    }
    case 'field': {
      const f = fields.get(n.label.toLowerCase());
      if (!f) throw new FormulaError(`there is no field called [${n.label}]`);
      const value = `(SELECT cv.value FROM lead_custom_value cv WHERE cv.lead_id = l.id AND cv.field_id = ${lit(f.id)})`;
      switch (f.type) {
        case 'number': case 'money': return { sql: `CAST(${value} AS REAL)`, kind: 'number' };
        case 'yes_no': return { sql: `(${value} = 'yes')`, kind: 'yes_no' };
        case 'date': return { sql: value, kind: 'date' };
        case 'text': case 'choice': return { sql: value, kind: 'text' };
        case 'formula': {
          if (using.includes(f.id)) throw new FormulaError(`[${f.label}] uses itself, through its own formula`);
          try {
            return compile(parseFormula(f.formula ?? ''), fields, [...using, f.id]);
          } catch (e) {
            throw e instanceof FormulaError && e.message.includes('uses itself') ? e : new FormulaError(`[${f.label}] has a mistake in its formula`);
          }
        }
      }
      throw new FormulaError(`[${n.label}] can't be used here`);
    }
    case 'neg': return { sql: `(-${want(c(n.e), 'number', 'a minus sign')})`, kind: 'number' };
    case 'not': return { sql: `(NOT ${want(c(n.e), 'yes_no', '"not"')})`, kind: 'yes_no' };
    case 'bin': {
      const l = c(n.l);
      const r = c(n.r);
      if (n.op === 'and' || n.op === 'or') return { sql: `(${want(l, 'yes_no', `"${n.op}"`)} ${n.op.toUpperCase()} ${want(r, 'yes_no', `"${n.op}"`)})`, kind: 'yes_no' };
      if (['+', '-', '*', '/'].includes(n.op)) {
        const a = want(l, 'number', `"${n.op}"`);
        const b = want(r, 'number', `"${n.op}"`);
        return { sql: n.op === '/' ? `(${a} * 1.0 / ${b})` : `(${a} ${n.op} ${b})`, kind: 'number' };
      }
      if (l.kind !== r.kind) throw new FormulaError(`can't compare ${KIND_WORD[l.kind]} with ${KIND_WORD[r.kind]}`);
      const op = n.op === '!=' ? '!=' : n.op;
      return { sql: l.kind === 'text' ? `(lower(${l.sql}) ${op} lower(${r.sql}))` : `(${l.sql} ${op} ${r.sql})`, kind: 'yes_no' };
    }
    case 'call': return call(n.name, n.args.map(c));
  }
}

function call(name: string, a: Compiled[]): Compiled {
  const count = (min: number, max: number) => {
    if (a.length < min || a.length > max) throw new FormulaError(`${name}() takes ${min === max ? min : max === Infinity ? `${min} or more` : `${min} or ${max}`} value${max === 1 ? '' : 's'}`);
  };
  const want = (x: Compiled, kind: FormulaKind) => {
    if (x.kind !== kind) throw new FormulaError(`${name}() needs ${KIND_WORD[kind]}, not ${KIND_WORD[x.kind]}`);
    return x.sql;
  };
  switch (name) {
    case 'if': {
      count(2, 41);
      const kind = a[1]!.kind;
      let sql = 'CASE';
      for (let i = 0; i + 1 < a.length; i += 2) {
        if (a[i]!.kind !== 'yes_no') throw new FormulaError('each test in if() needs a yes/no, like age > 60');
        sql += ` WHEN ${a[i]!.sql} THEN ${want(a[i + 1]!, kind)}`;
      }
      if (a.length % 2) sql += ` ELSE ${want(a[a.length - 1]!, kind)}`;
      return { sql: `${sql} END`, kind };
    }
    case 'ifblank':
      count(2, 2);
      return { sql: `coalesce(${a[0]!.sql}, ${want(a[1]!, a[0]!.kind)})`, kind: a[0]!.kind };
    case 'blank':
      count(1, 1);
      return { sql: `(${a[0]!.sql} IS NULL OR ${a[0]!.sql} = '')`, kind: 'yes_no' };
    case 'has': case 'has_tag':
      count(1, 1);
      return { sql: `EXISTS (SELECT 1 FROM lead_tag xt JOIN tag tt ON tt.id = xt.tag_id WHERE xt.lead_id = l.id AND lower(tt.name) = lower(${want(a[0]!, 'text')}))`, kind: 'yes_no' };
    // The log (lead_event): when a tag was last put on or taken off, in your time, and how often it was put on.
    case 'added': case 'removed':
      count(1, 1);
      return { sql: `(SELECT datetime(max(e.at), 'localtime') ${TAG_LINES(name === 'added' ? 'tag_added' : 'tag_removed', want(a[0]!, 'text'))})`, kind: 'date' };
    case 'times':
      count(1, 2);
      return { sql: `(SELECT COUNT(*) ${TAG_LINES('tag_added', want(a[0]!, 'text'))}${a[1] ? ` AND ${WITHIN_DAYS('e.at', want(a[1], 'number'))}` : ''})`, kind: 'number' };
    case 'before': {
      count(2, 2);
      const last = (x: Compiled) => `(SELECT max(e.at) ${TAG_LINES('tag_added', want(x, 'text'))})`;
      return { sql: `coalesce(${last(a[0]!)} < ${last(a[1]!)}, 0)`, kind: 'yes_no' };
    }
    // Calls saved with an outcome (by its name or code), not undone, optionally in the last N days.
    case 'pressed': {
      count(1, 2);
      const outcome = want(a[0]!, 'text');
      return {
        sql: `(SELECT COUNT(*) FROM call c JOIN call_outcome o ON o.call_id = c.id WHERE c.lead_id = l.id AND c.voided_at IS NULL AND ${CURRENT_OUTCOME}
          AND o.outcome_code IN (SELECT oc.code FROM outcome_code oc WHERE oc.code = ${outcome} OR lower(oc.label) = lower(${outcome}))${a[1] ? ` AND ${WITHIN_DAYS('c.requested_at', want(a[1], 'number'))}` : ''})`,
        kind: 'number',
      };
    }
    case 'min': case 'max':
      count(2, 20);
      return { sql: `${name}(${a.map((x) => want(x, 'number')).join(', ')})`, kind: 'number' };
    case 'round':
      count(1, 2);
      return { sql: `round(${want(a[0]!, 'number')}, ${a[1] ? want(a[1], 'number') : 0})`, kind: 'number' };
    case 'abs':
      count(1, 1);
      return { sql: `abs(${want(a[0]!, 'number')})`, kind: 'number' };
    case 'contains':
      count(2, 2);
      return { sql: `(instr(lower(${want(a[0]!, 'text')}), lower(${want(a[1]!, 'text')})) > 0)`, kind: 'yes_no' };
    case 'days_since': case 'days_until': {
      count(1, 1);
      const d = want(a[0]!, 'date');
      const today = "julianday(date('now', 'localtime'))";
      // date() so a time of day (from added()) counts calendar days, like a date field.
      return { sql: name === 'days_since' ? `CAST(${today} - julianday(date(${d})) AS INTEGER)` : `CAST(julianday(date(${d})) - ${today} AS INTEGER)`, kind: 'number' };
    }
    case 'hours_since': {
      count(1, 1);
      return { sql: `((julianday('now', 'localtime') - julianday(${want(a[0]!, 'date')})) * 24)`, kind: 'number' };
    }
  }
  throw new FormulaError(`there is no ${name}()`);
}

/** What a formula works out to, as a field's value: numbers without trailing zeros (2 places at most), yes/no as "yes"/"no". */
function asValue(x: Compiled): { sql: string; result: 'number' | 'text' | 'yes_no' } {
  if (x.kind === 'number') return { sql: `CASE WHEN x IS NULL THEN NULL WHEN x = CAST(x AS INTEGER) THEN CAST(x AS INTEGER) ELSE round(x, 2) END`, result: 'number' };
  if (x.kind === 'yes_no') return { sql: "CASE WHEN x THEN 'yes' WHEN NOT x THEN 'no' END", result: 'yes_no' };
  return { sql: 'x', result: 'text' };
}

function fieldDefs(db: DB): FieldDef[] {
  return db.prepare('SELECT id, label, type, formula FROM custom_field').all() as FieldDef[];
}

/** Checks a formula against the fields there are now; `selfId` is the field it belongs to, so it can't use itself. */
export function compileFormula(formula: string, fields: FieldDef[], selfId: string | null = null): { sql: string; result: 'number' | 'text' | 'yes_no' } {
  const byLabel = new Map(fields.filter((f) => f.id !== selfId || f.type !== 'formula').map((f) => [f.label.toLowerCase(), f]));
  if (selfId) {
    const self = fields.find((f) => f.id === selfId);
    if (self) byLabel.set(self.label.toLowerCase(), { ...self, type: 'formula', formula });
  }
  const x = compile(parseFormula(formula), byLabel, selfId ? [selfId] : []);
  const v = asValue(x);
  return { sql: `(SELECT ${v.sql} FROM (SELECT ${x.sql} x))`, result: v.result };
}

/** What each formula field works out to (null when its formula has a mistake), by field id. */
export function formulaResults(fields: FieldDef[]): Map<string, 'number' | 'text' | 'yes_no' | null> {
  const out = new Map<string, 'number' | 'text' | 'yes_no' | null>();
  for (const f of fields) {
    if (f.type !== 'formula') continue;
    try {
      out.set(f.id, compileFormula(f.formula ?? '', fields, f.id).result);
    } catch {
      out.set(f.id, null);
    }
  }
  return out;
}

/** Makes the lead_field_value view again from the fields there are now. Call after a formula field changes. */
export function syncFieldValueView(db: DB): void {
  const fields = fieldDefs(db);
  const parts = ['SELECT lead_id, field_id, value FROM lead_custom_value'];
  for (const f of fields) {
    if (f.type !== 'formula') continue;
    let sql: string;
    try {
      sql = compileFormula(f.formula ?? '', fields, f.id).sql;
    } catch {
      continue; // A formula with a mistake has no values; Settings shows the mistake.
    }
    parts.push(`SELECT lead_id, ${lit(f.id)}, value FROM (SELECT l.id lead_id, ${sql} value FROM lead l JOIN lead_state s ON s.lead_id = l.id) WHERE value IS NOT NULL`);
  }
  db.transaction(() => {
    db.exec('DROP VIEW IF EXISTS lead_field_value');
    db.exec(`CREATE VIEW lead_field_value AS ${parts.join('\nUNION ALL\n')}`);
  })();
}


/** What a formula gives your leads now, or its mistake. `fieldId` is the field being edited, if it's saved already. */
export function previewFormula(db: DB, formula: string, fieldId: string | null = null): FormulaPreview {
  const empty = { result: null, total: 0, filled: 0, low: null, high: null, average: null, samples: [] };
  let c: ReturnType<typeof compileFormula>;
  try {
    c = compileFormula(formula, fieldDefs(db), fieldId ?? '(new)');
  } catch (e) {
    if (e instanceof FormulaError) return { ...empty, error: e.message, at: e.at };
    throw e;
  }
  const base = `SELECT l.id, ${LEAD_NAME} name, s.last_call_at, l.created_at, ${c.sql} value FROM lead l JOIN lead_state s ON s.lead_id = l.id`;
  const stats = db.prepare(`SELECT COUNT(*) total, COUNT(value) filled, min(value) low, max(value) high, avg(value) average FROM (${base})`).get() as {
    total: number; filled: number; low: number | null; high: number | null; average: number | null;
  };
  const samples = (db.prepare(`SELECT id, name, value FROM (${base}) ORDER BY coalesce(last_call_at, created_at) DESC LIMIT 8`).all() as { id: string; name: string | null; value: unknown }[])
    .map((r) => ({ id: r.id, name: r.name || 'No name', value: r.value == null ? null : String(r.value) }));
  const num = c.result === 'number';
  return {
    error: null, at: null, result: c.result, total: stats.total, filled: stats.filled, samples,
    low: num ? stats.low : null, high: num ? stats.high : null, average: num && stats.average != null ? Math.round(stats.average * 100) / 100 : null,
  };
}
