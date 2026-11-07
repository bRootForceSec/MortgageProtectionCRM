import { call, pyString, readCall, RuleTextError, str, tokens, type Value } from './ruleText.js';
import { BUTTON_BORDERS, BUTTON_COLORS, BUTTON_FILLS, ButtonDef } from './buttons.js';

// A Calling screen button as Python (Settings → Buttons, the Python tab), and back, in the same style as rules:
//
//   @button(counts_as="Dial: No answer", shows_when='not has("Voicemail")', asks=["Best time"], color="red", border="dotted")
//   def button():
//       "Left voicemail"
//       add_tag("Voicemail")
//       remove_tag("Hot")
//
// @button says what it counts as, when it shows, which of your fields it asks for and how it looks; @hidden keeps it off the Calling screen; the
// docstring is its name, and each line is what it does to tags. Tags and outcomes go by name.

/** Turns ids into names and back, for tags, your fields and outcomes (an outcome reads by its name or its code). */
export interface ButtonNames {
  tag: (id: string) => string | undefined;
  tagId: (name: string) => string | undefined;
  field: (id: string) => string | undefined;
  fieldId: (name: string) => string | undefined;
  outcome: (code: string) => string | undefined;
  outcomeCode: (nameOrCode: string) => string | undefined;
}

const DEFAULTS = ButtonDef.parse({ id: 'x', outcome: 'x', label: 'x' });

/** The button as Python. */
export function buttonToPython(b: ButtonDef, n: ButtonNames): string {
  const kw: [string, Value][] = [['counts_as', n.outcome(b.outcome) ?? b.outcome]];
  if (b.show_when) kw.push(['shows_when', b.show_when]);
  if (b.asks.length) kw.push(['asks', b.asks.map((f) => n.field(f) ?? f)]);
  for (const k of ['color', 'fill', 'border', 'tooltip'] as const) if (b[k] !== DEFAULTS[k]) kw.push([k, b[k]]);
  if (b.confirm) kw.push(['confirm', true]);
  const lines = [`@${call('button', [], kw)}`];
  if (b.hidden) lines.push('@hidden');
  lines.push('def button():', `    ${pyString(b.label)}`);
  for (const t of b.add_tags) lines.push(`    ${call('add_tag', [n.tag(t) ?? t])}`);
  for (const t of b.remove_tags) lines.push(`    ${call('remove_tag', [n.tag(t) ?? t])}`);
  return lines.join('\n');
}

const oneOf = <T extends string>(v: Value | undefined, all: readonly T[], what: string, line: number): T => {
  const s = str(v, what, line).toLowerCase();
  if (!(all as readonly string[]).includes(s)) throw new RuleTextError(`${what} is one of ${all.map((x) => `"${x}"`).join(', ')}`, line);
  return s as T;
};

/**
 * Reads a button written in Python. Keeps `base`'s id; an outcome's own button (its id is the outcome's code) always
 * counts as that outcome.
 */
export function pythonToButton(src: string, base: ButtonDef, n: ButtonNames): ButtonDef {
  const lines = src.split('\n').map((text, i) => ({ text: text.replace(/\t/g, '    '), no: i + 1 })).filter((l) => l.text.trim() && !l.text.trim().startsWith('#'));
  const own = base.id === base.outcome;
  let deco: Partial<ButtonDef> | null = null;
  let hidden = false;
  let label: string | null = null;
  let inDef = false;
  let indent = -1;
  const add: string[] = [];
  const remove: string[] = [];
  for (const { text, no } of lines) {
    const ind = text.length - text.trimStart().length;
    const t = text.trim();
    if (!inDef) {
      if (ind) throw new RuleTextError('only the lines inside def button(): are indented', no);
      if (t.startsWith('@')) {
        const c = readCall(tokens(t.slice(1), no), no);
        if (c.name === 'hidden' && !c.args.length && !c.kw.size) { hidden = true; continue; }
        if (c.name !== 'button') throw new RuleTextError(`there is no @${c.name}: use @button or @hidden`, no);
        if (deco) throw new RuleTextError('a button has one @button', no);
        if (c.args.length) throw new RuleTextError('button() takes names, like button(counts_as="Dial: No answer")', no);
        const d: Partial<ButtonDef> = {};
        for (const [k, v] of c.kw) {
          switch (k) {
            case 'counts_as': {
              const name = str(v, 'counts_as=', no);
              const code = n.outcomeCode(name);
              if (!code) throw new RuleTextError(`there is no outcome called "${name}"`, no);
              if (own && code !== base.outcome) throw new RuleTextError(`this is ${n.outcome(base.outcome) ?? base.outcome}'s own button: it always counts as that`, no);
              d.outcome = code;
              break;
            }
            case 'shows_when': d.show_when = str(v, 'shows_when=', no).trim(); break;
            case 'asks':
              if (!Array.isArray(v)) throw new RuleTextError('asks= needs a list of your fields, like ["Best time"]', no);
              d.asks = v.map((x) => {
                const name = str(x, 'a field', no);
                const id = n.fieldId(name);
                if (!id) throw new RuleTextError(`there is no field called "${name}" a button can ask for`, no);
                return id;
              });
              break;
            case 'color': d.color = oneOf(v, BUTTON_COLORS, 'color=', no); break;
            case 'fill': d.fill = oneOf(v, BUTTON_FILLS, 'fill=', no); break;
            case 'border': d.border = oneOf(v, BUTTON_BORDERS, 'border=', no); break;
            case 'tooltip': d.tooltip = str(v, 'tooltip=', no); break;
            case 'confirm':
              if (typeof v !== 'boolean') throw new RuleTextError('confirm= is True or False', no);
              d.confirm = v;
              break;
            default: throw new RuleTextError(`button() doesn't take ${k}=: use counts_as, shows_when, asks, color, fill, border, tooltip or confirm`, no);
          }
        }
        if (!d.outcome) throw new RuleTextError('say what it counts as: @button(counts_as="Dial: No answer")', no);
        deco = d;
        continue;
      }
      if (!/^def\s+\w+\s*\(\s*\)\s*:\s*(#.*)?$/.test(t)) throw new RuleTextError('expected def button():', no);
      inDef = true;
      continue;
    }
    if (!ind) throw new RuleTextError('one button here: the lines inside def button(): are indented', no);
    if (indent < 0) {
      indent = ind;
      const doc = tokens(t, no);
      if (doc.length !== 1 || doc[0]!.t !== 'str') throw new RuleTextError('the first line inside def button(): is its name, in quotes', no);
      label = doc[0]!.v;
      continue;
    }
    if (ind !== indent) throw new RuleTextError('the lines inside def button(): are indented the same', no);
    const c = readCall(tokens(t, no), no);
    if (c.name !== 'add_tag' && c.name !== 'remove_tag') throw new RuleTextError(`a button can add_tag("...") or remove_tag("..."), not ${c.name}()`, no);
    if (c.args.length !== 1 || c.kw.size) throw new RuleTextError(`${c.name}() takes the tag's name`, no);
    const name = str(c.args[0], 'the tag', no);
    const id = n.tagId(name);
    if (!id) throw new RuleTextError(`there is no tag called "${name}": make it under Tags first`, no);
    (c.name === 'add_tag' ? add : remove).push(id);
  }
  const last = lines.at(-1)?.no ?? 1;
  if (!deco) throw new RuleTextError('say what it counts as: @button(counts_as="...") above def button():', 1);
  if (!inDef) throw new RuleTextError('expected def button(): after the @ lines', last);
  if (label == null) throw new RuleTextError('the first line inside def button(): is its name, in quotes', last);
  const r = ButtonDef.safeParse({ ...DEFAULTS, ...deco, id: base.id, label, hidden, add_tags: [...new Set(add)], remove_tags: [...new Set(remove)] });
  if (!r.success) throw new RuleTextError(r.error.issues[0]?.message ?? 'this button is not right yet', last);
  return r.data;
}
