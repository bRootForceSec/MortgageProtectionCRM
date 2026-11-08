import { WEEKDAYS } from './rules.js';
import { isStep } from './followUps.js';
import type { LeadQuery } from './leadFilter.js';
import type { Rule, RuleAction, RuleTrigger } from './rules.js';

// A rule as Python (the rule editor's Python view), and back. It is plain Python syntax: decorators say when the rule
// runs and which leads it's for, the function's docstring is its name, an `if` is its condition, and each line in it
// is one action. Tags, fields and statuses go by name here, by id in the rule:
//
//   @when(tag_added="No show")
//   @leads(status="appt_no_show", last_call="today")
//   def rule():
//       "No-shows get a callback"
//       if times("No show") >= 3:
//           add_tag("Ghosting")
//           counter("No-show streak", add=1)
//
// Each kind of rule the form can make can be written here, and each one written here opens in the form.

/** Turns ids into names and back, for tags, your fields and your statuses. */
export interface RuleNames {
  tag: (id: string) => string | undefined;
  tagId: (name: string) => string | undefined;
  field: (id: string) => string | undefined;
  fieldId: (name: string) => string | undefined;
  status: (id: string) => string | undefined;
  statusId: (name: string) => string | undefined;
}

export class RuleTextError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

// ---------- writing ----------

/** A Python string literal for any text. */
export function pyString(s: string): string {
  const q = s.includes('"') && !s.includes("'") ? "'" : '"';
  return q + s.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`).replace(/\n/g, '\\n') + q;
}

export type Value = string | number | boolean | Value[];
const py = (v: Value): string => (typeof v === 'string' ? pyString(v) : typeof v === 'boolean' ? (v ? 'True' : 'False') : Array.isArray(v) ? `[${v.map(py).join(', ')}]` : String(v));
/** `name(args, key=value)` as Python. */
export const call = (name: string, args: Value[] = [], kw: [string, Value][] = []) => `${name}(${[...args.map(py), ...kw.map(([k, v]) => `${k}=${py(v)}`)].join(', ')})`;

function triggerText(t: RuleTrigger, n: RuleNames): string {
  switch (t.kind) {
    case 'daily': return call('when', [], [['daily', t.time], ['days', [...t.days].sort().map((d) => WEEKDAYS[d]!)]]);
    case 'call_saved': return call('when', [], [['call_saved', t.outcomes]]);
    case 'manual': return call('when', [], [['manual', true]]);
    case 'tag_added': case 'tag_removed': return call('when', [], [[t.kind, t.tag]]);
    case 'status': return call('when', [], [[t.when, n.status(t.status_id) ?? t.status_id]]);
    case 'becomes_true': return call('when', [], [['becomes_true', t.condition], ...(t.already ? [['already', true] as [string, Value]] : [])]);
    case 'list_empty': return call('when', [], [['list_empty', true]]);
    case 'imported': return call('when', [], [['imported', true]]);
  }
}

/** The filter keys that hold an id, written as a name. */
const BY_NAME: Partial<Record<keyof LeadQuery, { key: string; name: (n: RuleNames, id: string) => string | undefined }>> = {
  tag: { key: 'tag', name: (n, id) => (id === 'none' ? 'none' : n.tag(id)) },
  in_status: { key: 'in_status', name: (n, id) => n.status(id) },
  field_id: { key: 'field', name: (n, id) => n.field(id) },
  sort_field: { key: 'sort_by', name: (n, id) => n.field(id) },
};

function leadsText(f: Partial<LeadQuery>, n: RuleNames): string | null {
  const kw: [string, Value][] = [];
  for (const [k, v] of Object.entries(f) as [keyof LeadQuery, unknown][]) {
    if (v == null || v === '' || k === 'where' || (k === 'status' && v === 'all')) continue;
    const named = BY_NAME[k];
    if (named) kw.push([named.key, named.name(n, String(v)) ?? String(v)]);
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') kw.push([k, v === '1' && (k === 'on_list' || k === 'not_on_list') ? true : v]);
  }
  return kw.length ? call('leads', [], kw) : null;
}

function actionText(a: RuleAction, n: RuleNames): string {
  switch (a.kind) {
    case 'add_to_list': case 'remove_from_list': return call(a.kind);
    case 'add_tag': case 'remove_tag': return call(a.kind, [a.tag]);
    case 'set_field': return call('set_field', [n.field(a.field_id) ?? a.field_id, a.value]);
    case 'counter': return call('counter', [n.field(a.field_id) ?? a.field_id], [[a.op, a.by]]);
    case 'mark_dead': return a.reason ? call('mark_dead', [a.reason]) : call('mark_dead');
    case 'come_back': return call('come_back', a.steps);
    case 'wait': return call('wait', [a.after]);
  }
}

/** The rule as Python. */
export function ruleToPython(r: Rule, n: RuleNames): string {
  const lines = [`@${triggerText(r.trigger, n)}`];
  const leads = leadsText(r.filter, n);
  if (leads) lines.push(`@${leads}`);
  if (!r.enabled) lines.push('@off');
  lines.push('def rule():', `    ${pyString(r.name)}`);
  const where = r.filter.where?.trim();
  const pad = where ? '        ' : '    ';
  // A condition with a comment or more than one line goes in brackets over several lines, as Python allows.
  if (where && (where.includes('\n') || hasComment(where))) lines.push('    if (', ...where.split('\n').map((l) => `        ${l.trim()}`), '    ):');
  else if (where) lines.push(`    if ${where}:`);
  for (const a of r.actions) lines.push(pad + actionText(a, n));
  return lines.join('\n');
}

// ---------- reading ----------

type Tok = { t: 'name' | 'str' | 'num' | 'p'; v: string };

/** One line's words, texts, numbers and punctuation (a # comment ends it). Buttons in Python (buttonText.ts) read with these too. */
export function tokens(src: string, line: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') break;
    if (c === '"' || c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new RuleTextError('a text in quotes is not closed', line);
        const d = src[i]!;
        if (d === '\\') { const e = src[i + 1] ?? ''; s += e === 'n' ? '\n' : e; i += 2; continue; }
        if (d === c) { i++; break; }
        s += d;
        i++;
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && (c !== '-' || !out.length || out[out.length - 1]!.t === 'p')) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const name = /^[A-Za-z_]\w*/.exec(src.slice(i));
    if (name) { out.push({ t: 'name', v: name[0] }); i += name[0].length; continue; }
    if ('()[],=@:'.includes(c)) { out.push({ t: 'p', v: c }); i++; continue; }
    throw new RuleTextError(`"${c}" doesn't belong here`, line);
  }
  return out;
}

export interface Call { name: string; args: Value[]; kw: Map<string, Value> }

/** Reads `name(args, key=value)` (or a bare `name`) from the tokens. */
export function readCall(ts: Tok[], line: number): Call {
  let i = 0;
  const next = () => ts[i++];
  const want = (v: string) => { const t = next(); if (t?.t !== 'p' || t.v !== v) throw new RuleTextError(`expected "${v}"`, line); };
  const value = (): Value => {
    const t = next();
    if (!t) throw new RuleTextError('a value is missing', line);
    if (t.t === 'str') return t.v;
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'name' && (t.v === 'True' || t.v === 'False')) return t.v === 'True';
    if (t.t === 'p' && t.v === '[') {
      const list: Value[] = [];
      if (ts[i]?.v === ']') { i++; return list; }
      for (;;) {
        list.push(value());
        const s = next();
        if (s?.v === ']') return list;
        if (s?.v !== ',') throw new RuleTextError('expected "," or "]" in the list', line);
      }
    }
    throw new RuleTextError(`"${t.v}" isn't a value: put text in quotes`, line);
  };
  const head = next();
  if (head?.t !== 'name') throw new RuleTextError('expected a name like add_tag', line);
  const c: Call = { name: head.v, args: [], kw: new Map() };
  if (i === ts.length) return c;
  want('(');
  if (ts[i]?.v === ')') i++;
  else {
    for (;;) {
      if (ts[i]?.t === 'name' && ts[i + 1]?.v === '=') {
        const k = ts[i]!.v;
        i += 2;
        if (c.kw.has(k)) throw new RuleTextError(`${k}= is there twice`, line);
        c.kw.set(k, value());
      } else {
        if (c.kw.size) throw new RuleTextError('a value without a name can\'t come after one with a name', line);
        c.args.push(value());
      }
      const s = next();
      if (s?.v === ')') break;
      if (s?.v !== ',') throw new RuleTextError('expected "," or ")"', line);
    }
  }
  if (i !== ts.length) throw new RuleTextError(`something after ${c.name}(...) doesn't belong`, line);
  return c;
}

export const str = (v: Value | undefined, what: string, line: number): string => {
  if (typeof v !== 'string') throw new RuleTextError(`${what} needs text in quotes`, line);
  return v;
};
const int = (v: Value | undefined, what: string, line: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new RuleTextError(`${what} needs a whole number`, line);
  return v;
};

function readTrigger(c: Call, n: RuleNames, line: number): RuleTrigger {
  const [k, v] = [...c.kw.entries()][0] ?? [];
  const only = (...keys: string[]) => { for (const key of c.kw.keys()) if (!keys.includes(key)) throw new RuleTextError(`when() doesn't take ${key}=`, line); };
  if (c.args.length || !k) throw new RuleTextError('say when, like @when(tag_added="Hot") or @when(daily="08:00")', line);
  switch (k) {
    case 'daily': {
      only('daily', 'days');
      const time = str(v, 'daily=', line);
      const raw = c.kw.get('days') ?? WEEKDAYS.map((d) => d);
      if (!Array.isArray(raw)) throw new RuleTextError('days= needs a list, like ["Mon", "Tue"]', line);
      const days = raw.map((d) => {
        const at = WEEKDAYS.findIndex((w) => typeof d === 'string' && w.toLowerCase() === d.slice(0, 3).toLowerCase());
        if (at < 0) throw new RuleTextError(`"${String(d)}" isn't a day: use Sun, Mon, Tue, Wed, Thu, Fri or Sat`, line);
        return at;
      });
      return { kind: 'daily', time, days: [...new Set(days)].sort() };
    }
    case 'call_saved': {
      only('call_saved');
      if (!Array.isArray(v)) throw new RuleTextError('call_saved= needs a list of outcomes, like ["no_answer"] ([] for any)', line);
      return { kind: 'call_saved', outcomes: v.map((o) => str(o, 'an outcome', line)) };
    }
    case 'manual': only('manual'); return { kind: 'manual' };
    case 'list_empty': only('list_empty'); return { kind: 'list_empty' };
    case 'imported': only('imported'); return { kind: 'imported' };
    case 'tag_added': case 'tag_removed': only(k); return { kind: k, tag: str(v, `${k}=`, line) };
    case 'enters': case 'leaves': {
      only(k);
      const name = str(v, `${k}=`, line);
      const id = n.statusId(name);
      if (!id) throw new RuleTextError(`there is no status called "${name}"`, line);
      return { kind: 'status', status_id: id, when: k };
    }
    case 'becomes_true': {
      only('becomes_true', 'already');
      const already = c.kw.get('already');
      if (already !== undefined && typeof already !== 'boolean') throw new RuleTextError('already= is True or False', line);
      return { kind: 'becomes_true', condition: str(v, 'becomes_true=', line), ...(already ? { already: true } : {}) };
    }
  }
  throw new RuleTextError(`when() doesn't take ${k}=: use daily, call_saved, manual, tag_added, tag_removed, enters, leaves, becomes_true, list_empty or imported`, line);
}

const FILTER_KEYS = new Set([
  'status', 'search', 'batch_id', 'bulk_id', 'counties', 'area_codes', 'last_call', 'not_on_list', 'lead_type', 'age', 'imported', 'appt_days',
  'not_within_min', 'field_value', 'field_min', 'field_max', 'appt_days_ago', 'on_list',
]);

function readLeads(c: Call, n: RuleNames, line: number): Partial<LeadQuery> {
  if (c.args.length) throw new RuleTextError('leads() takes names, like leads(tag="Hot")', line);
  const f: Record<string, unknown> = {};
  for (const [k, v] of c.kw) {
    const named = (Object.entries(BY_NAME) as [string, { key: string }][]).find(([, x]) => x.key === k);
    if (named) {
      const name = str(v, `${k}=`, line);
      const id = k === 'tag' ? (name === 'none' ? 'none' : n.tagId(name)) : k === 'in_status' ? n.statusId(name) : n.fieldId(name);
      if (!id) throw new RuleTextError(`there is no ${k === 'tag' ? 'tag' : k === 'in_status' ? 'status' : 'field'} called "${name}"`, line);
      f[named[0]] = id;
      continue;
    }
    if (!FILTER_KEYS.has(k)) throw new RuleTextError(`leads() doesn't take ${k}=`, line);
    if (Array.isArray(v)) throw new RuleTextError(`${k}= takes one value`, line);
    f[k] = (k === 'on_list' || k === 'not_on_list') && v === true ? '1' : v;
  }
  return f as Partial<LeadQuery>;
}

function readAction(c: Call, n: RuleNames, line: number): RuleAction {
  const field = (v: Value | undefined) => {
    const name = str(v, 'the field', line);
    const id = n.fieldId(name);
    if (!id) throw new RuleTextError(`there is no field called "${name}"`, line);
    return id;
  };
  const noKw = () => { if (c.kw.size) throw new RuleTextError(`${c.name}() doesn't take names`, line); };
  switch (c.name) {
    case 'add_to_list': case 'remove_from_list':
      noKw();
      if (c.args.length) throw new RuleTextError(`${c.name}() takes nothing`, line);
      return { kind: c.name };
    case 'add_tag': case 'remove_tag':
      noKw();
      if (c.args.length !== 1) throw new RuleTextError(`${c.name}() takes the tag's name`, line);
      return { kind: c.name, tag: str(c.args[0], 'the tag', line) };
    case 'set_field':
      noKw();
      if (c.args.length !== 2) throw new RuleTextError('set_field() takes the field and the value, like set_field("Spouse", "yes")', line);
      return { kind: 'set_field', field_id: field(c.args[0]), value: typeof c.args[1] === 'number' ? String(c.args[1]) : str(c.args[1], 'the value', line) };
    case 'counter': {
      const op = c.kw.has('add') ? 'add' : c.kw.has('set') ? 'set' : null;
      if (c.args.length !== 1 || !op || c.kw.size !== 1) throw new RuleTextError('counter() takes the counter and add= or set=, like counter("Streak", add=1)', line);
      return { kind: 'counter', field_id: field(c.args[0]), op, by: int(c.kw.get(op), `${op}=`, line) };
    }
    case 'mark_dead':
      noKw();
      if (c.args.length > 1) throw new RuleTextError('mark_dead() takes a reason, or nothing', line);
      return c.args.length ? { kind: 'mark_dead', reason: str(c.args[0], 'the reason', line) } : { kind: 'mark_dead' };
    case 'come_back': {
      noKw();
      if (!c.args.length) throw new RuleTextError('come_back() takes its steps, like come_back("15m", "1d@09:00", "3d")', line);
      const steps = c.args.map((v) => str(v, 'a step', line).trim().toLowerCase());
      const bad = steps.find((x) => !isStep(x));
      if (bad !== undefined) throw new RuleTextError(`"${bad}" isn't a step: write each like 15m, 2h, 3d or 1d@09:00`, line);
      return { kind: 'come_back', steps };
    }
    case 'wait': {
      noKw();
      if (c.args.length !== 1) throw new RuleTextError('wait() takes how long, like wait("2h") or wait("1d@09:00")', line);
      const after = str(c.args[0], 'how long', line).trim().toLowerCase();
      if (!isStep(after)) throw new RuleTextError(`"${after}" isn't a wait: write it like 15m, 2h, 3d or 1d@09:00`, line);
      return { kind: 'wait', after };
    }
  }
  throw new RuleTextError(`there is no action ${c.name}(): use add_tag, remove_tag, add_to_list, remove_from_list, set_field, counter, mark_dead, come_back or wait`, line);
}

/** Whether a condition has a # comment (outside quotes). */
function hasComment(text: string): boolean {
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return true;
  }
  return false;
}

/** The `if` line's condition: the text between `if` and the colon that ends the line (quotes respected). */
function ifCondition(text: string, line: number): string {
  let q: string | null = null;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') break;
    else if (c === ':') end = i;
  }
  if (end < 0) throw new RuleTextError('an if line ends with ":"', line);
  const cond = text.slice(0, end).trim();
  if (!cond) throw new RuleTextError('the if has no condition', line);
  return cond;
}

/** Reads a rule written in Python. Keeps `base`'s id (and anything a rule has that the text doesn't say). */
export function pythonToRule(src: string, base: Rule, n: RuleNames): Rule {
  const lines = src.split('\n').map((text, i) => ({ text: text.replace(/\t/g, '    '), no: i + 1 })).filter((l) => l.text.trim());
  let trigger: RuleTrigger | null = null;
  let filter: Partial<LeadQuery> = {};
  let enabled = true;
  let name: string | null = null;
  let where: string | null = null;
  const actions: RuleAction[] = [];
  let state: 'top' | 'body' | 'if' = 'top';
  let bodyIndent = -1;
  let ifIndent = -1;
  for (let li = 0; li < lines.length; li++) {
    const { text, no } = lines[li]!;
    const indent = text.length - text.trimStart().length;
    const t = text.trim();
    if (t.startsWith('#')) continue; // a comment line (inside an if ( ... ) they stay with the condition)
    if (state === 'top') {
      if (indent) throw new RuleTextError('only the lines inside def rule(): are indented', no);
      if (t.startsWith('@')) {
        const c = readCall(tokens(t.slice(1), no), no);
        if (c.name === 'when') {
          if (trigger) throw new RuleTextError('a rule has one @when', no);
          trigger = readTrigger(c, n, no);
        } else if (c.name === 'leads') filter = readLeads(c, n, no);
        else if (c.name === 'off' && !c.args.length && !c.kw.size) enabled = false;
        else throw new RuleTextError(`there is no @${c.name}: use @when, @leads or @off`, no);
        continue;
      }
      if (!/^def\s+\w+\s*\(\s*\)\s*:\s*(#.*)?$/.test(t)) throw new RuleTextError('expected def rule():', no);
      state = 'body';
      continue;
    }
    if (bodyIndent < 0) {
      if (!indent) throw new RuleTextError('the lines inside def rule(): are indented', no);
      bodyIndent = indent;
      const doc = tokens(t, no);
      if (doc.length !== 1 || doc[0]!.t !== 'str') throw new RuleTextError('the first line inside def rule(): is its name, in quotes', no);
      name = doc[0]!.v;
      continue;
    }
    if (state === 'if' && indent > bodyIndent) {
      if (ifIndent < 0) ifIndent = indent;
      else if (indent !== ifIndent) throw new RuleTextError('the lines under the if are indented the same', no);
      actions.push(readAction(readCall(tokens(t, no), no), n, no));
      continue;
    }
    if (indent !== bodyIndent) throw new RuleTextError(indent < bodyIndent ? 'the rule ends at the end of def rule(): (one rule here)' : 'this line is indented too far', no);
    if (/^if\b/.test(t)) {
      if (where != null || actions.length) throw new RuleTextError('a rule has one if, before its actions', no);
      if (/^if\s*\($/.test(t)) {
        // if (
        //     condition lines
        // ):
        const body: string[] = [];
        for (li++; li < lines.length && lines[li]!.text.trim() !== '):'; li++) body.push(lines[li]!.text.trim());
        if (li >= lines.length) throw new RuleTextError('the if ( ... has no "):" line to close it', no);
        if (!body.length) throw new RuleTextError('the if has no condition', no);
        where = body.join('\n');
      } else where = ifCondition(t.slice(2), no);
      state = 'if';
      continue;
    }
    if (state === 'if') throw new RuleTextError('after an if, every action goes under it', no);
    actions.push(readAction(readCall(tokens(t, no), no), n, no));
  }
  const last = lines.at(-1)?.no ?? 1;
  if (!trigger) throw new RuleTextError('say when it runs: @when(...) above def rule():', 1);
  if (state === 'top') throw new RuleTextError('expected def rule(): after the @ lines', last);
  if (name == null) throw new RuleTextError('the first line inside def rule(): is its name, in quotes', last);
  if (!actions.length) throw new RuleTextError('give the rule something to do, like add_tag("Hot")', last);
  return { ...base, name, enabled, trigger, filter: where ? { ...filter, where } : filter, actions };
}
