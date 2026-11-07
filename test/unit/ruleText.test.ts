import { describe, it, expect } from 'vitest';
import { pythonToRule, pyString, ruleToPython, RuleTextError, type RuleNames } from '../../src/shared/ruleText.js';
import { STARTER_RULES, type Rule } from '../../src/shared/rules.js';

const pairs = (o: Record<string, string>) => {
  const back = Object.fromEntries(Object.entries(o).map(([k, v]) => [v.toLowerCase(), k]));
  return { name: (id: string) => o[id], id: (n: string) => back[n.toLowerCase()] };
};
const tags = pairs({ t1: 'Hot', t2: 'No show' });
const fields = pairs({ f1: 'Spouse decides', f2: 'No-show streak' });
const statuses = pairs({ s1: 'Needs rebook' });
const names: RuleNames = { tag: tags.name, tagId: tags.id, field: fields.name, fieldId: fields.id, status: statuses.name, statusId: statuses.id };

const base: Rule = { id: 'r1', name: 'x', enabled: true, trigger: { kind: 'manual' }, filter: {}, actions: [{ kind: 'add_to_list' }] };
const round = (r: Rule) => pythonToRule(ruleToPython(r, names), { ...base, id: r.id }, names);

describe('a rule as Python', () => {
  it('writes the example rule as plain Python', () => {
    const r: Rule = {
      id: 'r1', name: 'No-shows get a callback', enabled: true,
      trigger: { kind: 'tag_added', tag: 'No show' },
      filter: { status: 'appt_no_show', last_call: 'today', tag: 't1', where: 'times("No show") >= 3' },
      actions: [{ kind: 'add_tag', tag: 'Ghosting' }, { kind: 'counter', field_id: 'f2', op: 'add', by: 1 }],
    };
    expect(ruleToPython(r, names)).toBe([
      '@when(tag_added="No show")',
      '@leads(status="appt_no_show", last_call="today", tag="Hot")',
      'def rule():',
      '    "No-shows get a callback"',
      '    if times("No show") >= 3:',
      '        add_tag("Ghosting")',
      '        counter("No-show streak", add=1)',
    ].join('\n'));
    expect(round(r)).toEqual(r);
  });

  it('every trigger and action goes there and back', () => {
    const rules: Rule[] = [
      { ...base, trigger: { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }, filter: { appt_days_ago: 1, on_list: '1' }, actions: [{ kind: 'remove_from_list' }] },
      { ...base, enabled: false, trigger: { kind: 'call_saved', outcomes: ['no_answer', 'busy'] }, actions: [{ kind: 'mark_dead', reason: 'Rule: "dead"' }, { kind: 'mark_dead' }] },
      { ...base, trigger: { kind: 'tag_removed', tag: 'Hot' }, actions: [{ kind: 'remove_tag', tag: "It's" }, { kind: 'set_field', field_id: 'f1', value: 'yes' }] },
      { ...base, trigger: { kind: 'status', status_id: 's1', when: 'leaves' }, filter: { in_status: 's1', field_id: 'f2', field_min: 2 }, actions: [{ kind: 'counter', field_id: 'f2', op: 'set', by: 0 }] },
      { ...base, trigger: { kind: 'becomes_true', condition: `has("Hot") and state = 'OH'`, already: true }, filter: { tag: 'none' }, actions: [{ kind: 'add_to_list' }] },
      { ...base, trigger: { kind: 'call_saved', outcomes: [] }, filter: { where: 'attempts >= 2 # a comment: here' }, actions: [{ kind: 'add_tag', tag: 'a:b' }] },
      { ...base, filter: { where: '# who\nhas("Hot") or\nattempts > 3' }, actions: [{ kind: 'add_to_list' }] },
    ];
    for (const r of rules) expect(round(r)).toEqual(r);
    for (const [i, s] of STARTER_RULES.entries()) expect(round({ ...s, id: `s${i}` })).toEqual({ ...s, id: `s${i}` });
  });

  it('reads hand-written Python: tabs, comments, single quotes, days by name', () => {
    const r = pythonToRule([
      '# Mornings',
      "@when(daily='09:30', days=['monday', 'Fri'])",
      '@off',
      'def morning():  # any function name',
      '\t"Morning list"',
      '\tadd_to_list()   # put them on',
    ].join('\n'), base, names);
    expect(r).toEqual({ ...base, name: 'Morning list', enabled: false, trigger: { kind: 'daily', time: '09:30', days: [1, 5] }, actions: [{ kind: 'add_to_list' }] });
  });

  it('says what is wrong, and on which line', () => {
    const err = (src: string) => {
      try {
        pythonToRule(src, base, names);
      } catch (e) {
        if (e instanceof RuleTextError) return [e.line, e.message];
        throw e;
      }
      return null;
    };
    const head = '@when(manual=True)\ndef rule():\n    "R"\n';
    expect(err(`${head}    add_tag(Hot)`)).toEqual([4, '"Hot" isn\'t a value: put text in quotes']);
    expect(err(`${head}    tag("Hot")`)?.[1]).toMatch(/there is no action tag\(\)/);
    expect(err(`${head}    set_field("Nope", "x")`)).toEqual([4, 'there is no field called "Nope"']);
    expect(err(`@when(enters="Gone")\ndef rule():\n    "R"\n    add_to_list()`)).toEqual([1, 'there is no status called "Gone"']);
    expect(err(`${head}    if has("Hot")\n        add_to_list()`)).toEqual([4, 'an if line ends with ":"']);
    expect(err(`${head}    if has("Hot"):\n        add_to_list()\n    add_tag("x")`)).toEqual([6, 'after an if, every action goes under it']);
    expect(err(`def rule():\n    "R"\n    add_to_list()`)?.[1]).toMatch(/say when it runs/);
    expect(err(head)?.[1]).toMatch(/give the rule something to do/);
    expect(err(`${head}    add_tag("Hot"`)?.[1]).toMatch(/expected "," or "\)"/);
    expect(err(`@when(hourly=True)\n${head.slice(19)}    add_to_list()`)?.[1]).toMatch(/when\(\) doesn't take hourly=/);
  });

  it('quotes any text safely', () => {
    for (const s of ['plain', 'say "hi"', "it's", `both ' and "`, 'back\\slash', 'two\nlines']) {
      const r: Rule = { ...base, actions: [{ kind: 'add_tag', tag: s }] };
      expect(round(r)).toEqual(r);
    }
    expect(pyString('say "hi"')).toBe(`'say "hi"'`);
  });
});
