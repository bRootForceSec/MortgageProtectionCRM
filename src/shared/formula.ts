// Formula fields: a field worked out from the lead, like a lead score. The formula language, shared by Settings
// (the help list) and the server (which turns a formula into SQL, so filters, sorting and rules read it like any
// other field, always up to date).
//
//   if(age >= 60, 20, 0) + if(has_tag("Hot"), 30, 0) + min(attempts, 5) * -2 + ifblank([Mortgage payment], 0) / 100
//
// A yes/no formula is a condition, and can read the lead's log: has("No show") and days_since(added("No show")) <= 2.
//
// Numbers, "text", yes/no, [Your field name], the values below, + - * /, = != < <= > >=, and/or/not, ( ).

export type FormulaKind = 'number' | 'text' | 'yes_no' | 'date';

export const FORMULA_VALUES: readonly { name: string; kind: FormulaKind; help: string }[] = [
  { name: 'age', kind: 'number', help: "The lead's age" },
  { name: 'loan_amount', kind: 'number', help: 'Mortgage amount in dollars' },
  { name: 'attempts', kind: 'number', help: 'Calls made to the lead' },
  { name: 'days_since_last_call', kind: 'number', help: 'Whole days since the last call (blank if never called)' },
  { name: 'lead_age_days', kind: 'number', help: 'Whole days since the lead called in (blank if not known)' },
  { name: 'days_since_imported', kind: 'number', help: 'Whole days since the lead was imported' },
  { name: 'lead_type', kind: 'text', help: 'Lead type code, like "MP"' },
  { name: 'status', kind: 'text', help: 'Status, like "new", "retry", "callback", "booked", "dead"' },
  { name: 'appt_result', kind: 'text', help: 'How the latest appointment went, like "no_show" (blank if none)' },
  { name: 'state', kind: 'text', help: 'State, like "OH"' },
  { name: 'has_coborrower', kind: 'yes_no', help: 'Yes when the lead file shows a co-borrower' },
];

export const FORMULA_FUNCTIONS: readonly { name: string; usage: string; help: string }[] = [
  { name: 'if', usage: 'if(test, then, else)', help: 'Add more test, then pairs before else: if(age > 70, 3, age > 60, 2, 1)' },
  { name: 'ifblank', usage: 'ifblank(value, instead)', help: 'Use instead when the value is blank, so a sum still adds up' },
  { name: 'blank', usage: 'blank(value)', help: 'Yes when the value is blank' },
  { name: 'has', usage: 'has("Hot")', help: 'Yes when the lead has that tag now (has_tag works too)' },
  { name: 'added', usage: 'added("No show")', help: 'When that tag was last put on the lead (blank if never): use with days_since, hours_since' },
  { name: 'removed', usage: 'removed("No answer")', help: 'When that tag was last taken off the lead (blank if never)' },
  { name: 'times', usage: 'times("No answer", 7)', help: 'How many times that tag was put on the lead, in the last 7 days if you give a number' },
  { name: 'before', usage: 'before("Appt set", "No show")', help: 'Yes when the first tag was last put on before the second was' },
  { name: 'pressed', usage: 'pressed("Dial: No answer", 7)', help: 'Calls saved with that outcome (name or code), not undone, in the last 7 days if you give a number' },
  { name: 'min', usage: 'min(a, b, …)', help: 'The smallest' },
  { name: 'max', usage: 'max(a, b, …)', help: 'The largest' },
  { name: 'round', usage: 'round(value, places)', help: 'Rounds; places is optional' },
  { name: 'abs', usage: 'abs(value)', help: 'Without the minus sign' },
  { name: 'contains', usage: 'contains(text, "part")', help: 'Yes when the text has that part in it (any case)' },
  { name: 'days_since', usage: 'days_since([A date field])', help: 'Whole days since that date' },
  { name: 'days_until', usage: 'days_until([A date field])', help: 'Whole days until that date' },
  { name: 'hours_since', usage: 'hours_since(added("Called"))', help: 'Hours since that time' },
];

export type FormulaNode =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'value'; name: string }
  | { t: 'field'; label: string }
  | { t: 'call'; name: string; args: FormulaNode[] }
  | { t: 'neg'; e: FormulaNode }
  | { t: 'not'; e: FormulaNode }
  | { t: 'bin'; op: string; l: FormulaNode; r: FormulaNode };

/** What a formula gives your leads now (Settings shows it as you type), or its mistake. */
export interface FormulaPreview {
  error: string | null;
  /** Where the mistake is (a character in the formula), when known. */
  at: number | null;
  result: 'number' | 'text' | 'yes_no' | null;
  total: number;
  /** Leads it gives a value. */
  filled: number;
  /** For a number: the lowest, highest and average. */
  low: number | null;
  high: number | null;
  average: number | null;
  /** A few leads, most recently called first, with what it gives them. */
  samples: { id: string; name: string; value: string | null }[];
}

/** A mistake in a formula, said for the user, with where it is (0-based character). */
export class FormulaError extends Error {
  constructor(message: string, readonly at: number | null = null) {
    super(message);
  }
}

type Tok = { k: 'num' | 'str' | 'field' | 'word' | 'op'; v: string; at: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const at = i;
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) throw new FormulaError('that number is not right', at);
      out.push({ k: 'num', v: m[0], at });
      i += m[0].length;
    } else if (c === '"' || c === "'" || c === '“' || c === '”') {
      const close = c === '“' ? '”' : c;
      let j = i + 1;
      while (j < src.length && src[j] !== close && !(close === '”' && src[j] === '"')) j++;
      if (j >= src.length) throw new FormulaError('a "text" is missing its closing quote', at);
      out.push({ k: 'str', v: src.slice(i + 1, j), at });
      i = j + 1;
    } else if (c === '[') {
      const j = src.indexOf(']', i);
      if (j < 0) throw new FormulaError('a [field name] is missing its ]', at);
      const label = src.slice(i + 1, j).trim();
      if (!label) throw new FormulaError('put a field name between [ and ]', at);
      out.push({ k: 'field', v: label, at });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'word', v: m[0].toLowerCase(), at });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      const op = ['<=', '>=', '!=', '<>', '=='].includes(two) ? two : c;
      if (!['+', '-', '*', '/', '(', ')', ',', '=', '<', '>', '<=', '>=', '!=', '<>', '=='].includes(op)) throw new FormulaError(`"${c}" can't be used in a formula`, at);
      out.push({ k: 'op', v: op === '<>' ? '!=' : op === '==' ? '=' : op, at });
      i += op.length;
    }
  }
  return out;
}

/** Reads a formula. Throws a FormulaError the user can act on. Which names and fields exist is checked later. */
export function parseFormula(src: string): FormulaNode {
  if (!src.trim()) throw new FormulaError('write a formula');
  if (src.length > 2000) throw new FormulaError('keep the formula under 2000 characters');
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.k === 'op' && peek()!.v === v;
  const isWord = (v: string) => peek()?.k === 'word' && peek()!.v === v;
  const expect = (v: string, what: string) => {
    if (!isOp(v)) throw new FormulaError(`expected ${what}`, peek()?.at ?? src.length);
    p++;
  };
  let depth = 0;

  const or = (): FormulaNode => {
    let l = and();
    while (isWord('or')) { p++; l = { t: 'bin', op: 'or', l, r: and() }; }
    return l;
  };
  const and = (): FormulaNode => {
    let l = not();
    while (isWord('and')) { p++; l = { t: 'bin', op: 'and', l, r: not() }; }
    return l;
  };
  const not = (): FormulaNode => {
    if (isWord('not')) { p++; return { t: 'not', e: not() }; }
    return cmp();
  };
  const cmp = (): FormulaNode => {
    const l = add();
    const t = peek();
    if (t?.k === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(t.v)) { p++; return { t: 'bin', op: t.v, l, r: add() }; }
    return l;
  };
  const add = (): FormulaNode => {
    let l = mul();
    while (isOp('+') || isOp('-')) { const op = toks[p++]!.v; l = { t: 'bin', op, l, r: mul() }; }
    return l;
  };
  const mul = (): FormulaNode => {
    let l = unary();
    while (isOp('*') || isOp('/')) { const op = toks[p++]!.v; l = { t: 'bin', op, l, r: unary() }; }
    return l;
  };
  const unary = (): FormulaNode => {
    if (isOp('-')) { p++; return { t: 'neg', e: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return primary();
  };
  const primary = (): FormulaNode => {
    const t = peek();
    if (!t) throw new FormulaError('the formula stops too soon', src.length);
    if (++depth > 100) throw new FormulaError('the formula is nested too deep', t.at);
    try {
      p++;
      if (t.k === 'num') return { t: 'num', v: Number(t.v) };
      if (t.k === 'str') return { t: 'str', v: t.v };
      if (t.k === 'field') return { t: 'field', label: t.v };
      if (t.k === 'op' && t.v === '(') {
        const e = or();
        expect(')', 'a )');
        return e;
      }
      if (t.k === 'word') {
        if (t.v === 'yes' || t.v === 'true') return { t: 'bool', v: true };
        if (t.v === 'no' || t.v === 'false') return { t: 'bool', v: false };
        if (isOp('(')) {
          p++;
          const args: FormulaNode[] = [];
          if (!isOp(')')) {
            args.push(or());
            while (isOp(',')) { p++; args.push(or()); }
          }
          expect(')', `a ) to close ${t.v}(`);
          return { t: 'call', name: t.v, args };
        }
        return { t: 'value', name: t.v };
      }
      throw new FormulaError(`didn't expect "${t.v}" here`, t.at);
    } finally {
      depth--;
    }
  };

  const e = or();
  if (p < toks.length) throw new FormulaError(`didn't expect "${toks[p]!.v}" here`, toks[p]!.at);
  return e;
}

/** The [field names] a formula uses, as written. */
export function formulaFieldLabels(n: FormulaNode): string[] {
  switch (n.t) {
    case 'field': return [n.label];
    case 'call': return n.args.flatMap(formulaFieldLabels);
    case 'neg': case 'not': return formulaFieldLabels(n.e);
    case 'bin': return [...formulaFieldLabels(n.l), ...formulaFieldLabels(n.r)];
    default: return [];
  }
}

/** The formula with every [Old name] (any case) written as [New name]: a renamed field keeps working. */
export function renameFormulaField(src: string, from: string, to: string): string {
  return src.replace(/\[([^\]]*)\]/g, (m, label: string) => (label.trim().toLowerCase() === from.toLowerCase() ? `[${to}]` : m));
}
