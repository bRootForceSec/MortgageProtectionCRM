import { parseFormula, type FormulaNode } from './formula.js';

// Conditions, the form view: a condition is Python text (a yes/no formula), and the form edits the same thing as
// groups of rows. toPython writes the text; toForm reads text back into rows. Anything the rows don't cover becomes a
// "Python" row holding its own text, so the form can show every condition and the text always round-trips.

export type CmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=';
export const CMP_OPS: readonly { op: CmpOp; label: string }[] = [
  { op: '>=', label: 'at least' },
  { op: '<=', label: 'at most' },
  { op: '>', label: 'more than' },
  { op: '<', label: 'less than' },
  { op: '==', label: 'is' },
  { op: '!=', label: 'is not' },
];

export type Literal = string | number | boolean;

export type CondTerm =
  | { kind: 'has'; tag: string; negate: boolean }
  | { kind: 'status'; name: string; negate: boolean }
  | { kind: 'times'; tag: string; days: number | null; op: CmpOp; n: number }
  | { kind: 'since'; tag: string; event: 'added' | 'removed'; unit: 'days' | 'hours'; op: CmpOp; n: number }
  | { kind: 'before'; first: string; second: string }
  | { kind: 'pressed'; outcome: string; days: number | null; op: CmpOp; n: number }
  | { kind: 'value'; name: string; op: CmpOp; value: Literal }
  | { kind: 'field'; label: string; op: CmpOp; value: Literal }
  | { kind: 'python'; code: string };

export interface CondGroup {
  kind: 'group';
  /** all: every row is true; any: at least one. With negate: none of them / not all of them. */
  mode: 'all' | 'any';
  negate: boolean;
  items: CondItem[];
}
export type CondItem = CondGroup | CondTerm;

export const emptyGroup = (): CondGroup => ({ kind: 'group', mode: 'all', negate: false, items: [] });

/** Text in Python quotes. */
export function pyStr(s: string): string {
  return s.includes('"') ? `'${s}'` : `"${s}"`;
}
const pyLit = (v: Literal) => (typeof v === 'string' ? pyStr(v) : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v));

// ---------- writing Python ----------

const PREC: Record<string, number> = { or: 1, and: 2, not: 3, '=': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, neg: 7 };

/** Any formula, written as Python. */
export function formulaToPython(n: FormulaNode, outer = 0): string {
  const wrap = (s: string, prec: number) => (prec < outer ? `(${s})` : s);
  switch (n.t) {
    case 'num': return String(n.v);
    case 'str': return pyStr(n.v);
    case 'bool': return n.v ? 'True' : 'False';
    case 'value': return n.name;
    case 'field': return `field(${pyStr(n.label)})`;
    case 'neg': return wrap(`-${formulaToPython(n.e, PREC.neg)}`, PREC.neg!);
    case 'not': return wrap(`not ${formulaToPython(n.e, PREC.not)}`, PREC.not!);
    case 'bin': {
      const p = PREC[n.op]!;
      const op = n.op === '=' ? '==' : n.op;
      // Left-leaning: the right side of - and / (and of comparisons) needs brackets at the same level.
      return wrap(`${formulaToPython(n.l, p)} ${op} ${formulaToPython(n.r, p + 1)}`, p);
    }
    case 'call': {
      if (n.name === 'if' && n.args.length === 3) {
        return wrap(`${formulaToPython(n.args[1]!, 1)} if ${formulaToPython(n.args[0]!, 1)} else ${formulaToPython(n.args[2]!, 0)}`, 0);
      }
      const args = n.args.map((a) => formulaToPython(a));
      if ((n.name === 'times' || n.name === 'pressed') && args.length === 2) args[1] = `days=${args[1]}`;
      return `${n.name}(${args.join(', ')})`;
    }
  }
}

function termToPython(t: CondTerm): string {
  switch (t.kind) {
    case 'has': return `${t.negate ? 'not ' : ''}has(${pyStr(t.tag)})`;
    case 'status': return `${t.negate ? 'not ' : ''}in_list(${pyStr(t.name)})`;
    case 'times': return `times(${pyStr(t.tag)}${t.days != null ? `, days=${t.days}` : ''}) ${t.op} ${t.n}`;
    case 'since': return `${t.unit}_since(${t.event}(${pyStr(t.tag)})) ${t.op} ${t.n}`;
    case 'before': return `before(${pyStr(t.first)}, ${pyStr(t.second)})`;
    case 'pressed': return `pressed(${pyStr(t.outcome)}${t.days != null ? `, days=${t.days}` : ''}) ${t.op} ${t.n}`;
    case 'value': return `${t.name} ${t.op} ${pyLit(t.value)}`;
    case 'field': return `field(${pyStr(t.label)}) ${t.op} ${pyLit(t.value)}`;
    case 'python': return t.code.trim();
  }
}

/** The form as Python text. An empty group is True (every lead). */
export function toPython(g: CondGroup, nested = false): string {
  const parts = g.items
    .map((i) => (i.kind === 'group' ? toPython(i, true) : termToPython(i)))
    .filter((s) => s && s !== 'True')
    .map((s, _, all) => (all.length > 1 && !isSimple(s) ? `(${s})` : s));
  if (!parts.length) return g.negate ? 'False' : 'True';
  const body = parts.join(g.mode === 'all' ? ' and ' : ' or ');
  if (g.negate) return `not (${body})`;
  return nested && parts.length > 1 ? `(${body})` : body;
}

/** Text that is safe next to and/or without brackets: one comparison or call, no and/or/if of its own. */
function isSimple(s: string): boolean {
  if (/^\(.*\)$/s.test(s)) return true;
  try {
    const n = parseFormula(s);
    return !(n.t === 'bin' && (n.op === 'and' || n.op === 'or')) && !(n.t === 'call' && n.name === 'if');
  } catch {
    return false;
  }
}

// ---------- reading Python into the form ----------

const CMP: Record<string, CmpOp> = { '=': '==', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const str = (n: FormulaNode | undefined) => (n?.t === 'str' ? n.v : null);
const num = (n: FormulaNode | undefined) => (n?.t === 'num' ? n.v : n?.t === 'neg' && n.e.t === 'num' ? -n.e.v : null);
const lit = (n: FormulaNode | undefined): Literal | null => (n?.t === 'str' ? n.v : n?.t === 'bool' ? n.v : num(n));
const isCall = (n: FormulaNode | undefined, ...names: string[]): n is Extract<FormulaNode, { t: 'call' }> => n?.t === 'call' && names.includes(n.name);

function toTerm(n: FormulaNode): CondTerm {
  if (isCall(n, 'has', 'has_tag') && n.args.length === 1 && str(n.args[0]) != null) return { kind: 'has', tag: str(n.args[0])!, negate: false };
  if (n.t === 'not' && isCall(n.e, 'has', 'has_tag') && n.e.args.length === 1 && str(n.e.args[0]) != null) return { kind: 'has', tag: str(n.e.args[0])!, negate: true };
  const inList = (x: FormulaNode) => (isCall(x, 'in_list') || isCall(x, 'status')) && x.t === 'call' && x.args.length === 1 && str(x.args[0]) != null;
  if (inList(n) && n.t === 'call') return { kind: 'status', name: str(n.args[0])!, negate: false };
  if (n.t === 'not' && inList(n.e) && n.e.t === 'call') return { kind: 'status', name: str(n.e.args[0])!, negate: true };
  if (isCall(n, 'before') && str(n.args[0]) != null && str(n.args[1]) != null) return { kind: 'before', first: str(n.args[0])!, second: str(n.args[1])! };
  if (n.t === 'bin' && CMP[n.op]) {
    const op = CMP[n.op]!;
    const l = n.l, r = n.r;
    const days = (a: FormulaNode | undefined) => (a === undefined ? null : num(a));
    if (isCall(l, 'times') && str(l.args[0]) != null && num(r) != null && (l.args.length === 1 || days(l.args[1]) != null)) {
      return { kind: 'times', tag: str(l.args[0])!, days: days(l.args[1]), op, n: num(r)! };
    }
    if (isCall(l, 'pressed') && str(l.args[0]) != null && num(r) != null && (l.args.length === 1 || days(l.args[1]) != null)) {
      return { kind: 'pressed', outcome: str(l.args[0])!, days: days(l.args[1]), op, n: num(r)! };
    }
    if (isCall(l, 'days_since', 'hours_since') && l.args.length === 1 && isCall(l.args[0], 'added', 'removed') && str(l.args[0].args[0]) != null && num(r) != null) {
      return { kind: 'since', tag: str(l.args[0].args[0])!, event: l.args[0].name as 'added' | 'removed', unit: l.name === 'days_since' ? 'days' : 'hours', op, n: num(r)! };
    }
    if (l.t === 'value' && lit(r) != null) return { kind: 'value', name: l.name, op, value: lit(r)! };
    if (l.t === 'field' && lit(r) != null) return { kind: 'field', label: l.label, op, value: lit(r)! };
  }
  return { kind: 'python', code: formulaToPython(n) };
}

function toItem(n: FormulaNode): CondItem {
  if (n.t === 'bin' && (n.op === 'and' || n.op === 'or')) {
    const mode = n.op === 'and' ? 'all' : 'any';
    const flat = (x: FormulaNode): FormulaNode[] => (x.t === 'bin' && x.op === n.op ? [...flat(x.l), ...flat(x.r)] : [x]);
    return { kind: 'group', mode, negate: false, items: flat(n).map(toItem) };
  }
  if (n.t === 'not' && n.e.t === 'bin' && (n.e.op === 'and' || n.e.op === 'or')) return { ...(toItem(n.e) as CondGroup), negate: true };
  return toTerm(n);
}

/** Reads a condition into the form. Throws FormulaError when the text has a mistake. An empty text is an empty group. */
export function toForm(src: string): CondGroup {
  if (!src.trim()) return emptyGroup();
  const item = toItem(parseFormula(src));
  return item.kind === 'group' ? item : { kind: 'group', mode: 'all', negate: false, items: [item] };
}
