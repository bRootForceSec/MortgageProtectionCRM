import { describe, it, expect } from 'vitest';
import { buttonToPython, pythonToButton, type ButtonNames } from '../../src/shared/buttonText.js';
import { ButtonDef } from '../../src/shared/buttons.js';
import { RuleTextError } from '../../src/shared/ruleText.js';
import { OUTCOMES } from '../../src/shared/outcomes.js';

const tagNames: Record<string, string> = { t1: 'Voicemail', t2: 'Hot' };
const names: ButtonNames = {
  tag: (id) => tagNames[id],
  tagId: (n) => Object.keys(tagNames).find((k) => tagNames[k]!.toLowerCase() === n.toLowerCase()),
  outcome: (c) => (c in OUTCOMES ? OUTCOMES[c as keyof typeof OUTCOMES].label : undefined),
  outcomeCode: (n) => (n in OUTCOMES ? n : Object.keys(OUTCOMES).find((c) => OUTCOMES[c as keyof typeof OUTCOMES].label.toLowerCase() === n.toLowerCase())),
};
const b = (over: Partial<ButtonDef>) => ButtonDef.parse({ id: 'b1', outcome: 'no_answer', label: 'Left voicemail', ...over });
const round = (x: ButtonDef) => pythonToButton(buttonToPython(x, names), { ...x, label: 'other', outcome: x.id === x.outcome ? x.outcome : 'no_appt' }, names);

describe('a button as Python', () => {
  it('writes a button as plain Python, and reads it back the same', () => {
    const x = b({ show_when: 'not has("Voicemail")', color: 'red', border: 'dotted', add_tags: ['t1'], remove_tags: ['t2'] });
    expect(buttonToPython(x, names)).toBe([
      `@button(counts_as="Dial: No answer", shows_when='not has("Voicemail")', color="red", border="dotted")`,
      'def button():',
      '    "Left voicemail"',
      '    add_tag("Voicemail")',
      '    remove_tag("Hot")',
    ].join('\n'));
    expect(round(x)).toEqual(x);
  });

  it('every look and setting goes there and back', () => {
    const all: ButtonDef[] = [
      b({}),
      b({ hidden: true, confirm: true, tooltip: "They're \"busy\"", fill: 'filled', color: 'blue', border: 'dashed' }),
      b({ show_when: '# who\nattempts >= 3' }),
      ButtonDef.parse({ id: 'appt_sale', outcome: 'appt_sale', label: 'Sold!', color: 'green', fill: 'filled' }),
    ];
    for (const x of all) expect(round(x)).toEqual(x);
  });

  it('reads hand-written Python: an outcome by its code, single quotes, comments, tabs', () => {
    const x = pythonToButton(["# mine", "@button(counts_as='no_appt', color='Purple')", '@hidden', 'def anything():', "\t'Talked, cold'", "\tadd_tag('hot')  # on"].join('\n'), b({}), names);
    expect(x).toEqual(b({ outcome: 'no_appt', label: 'Talked, cold', color: 'purple', hidden: true, add_tags: ['t2'] }));
  });

  it('says what is wrong, and on which line', () => {
    const err = (src: string, base = b({})) => {
      try {
        pythonToButton(src, base, names);
      } catch (e) {
        if (e instanceof RuleTextError) return [e.line, e.message];
        throw e;
      }
      return null;
    };
    const top = '@button(counts_as="Dial: No answer")\ndef button():\n    "X"\n';
    expect(err(`${top}    add_tag("Nope")`)).toEqual([4, 'there is no tag called "Nope": make it under Tags first']);
    expect(err(`${top}    add_to_list()`)).toEqual([4, 'a button can add_tag("...") or remove_tag("..."), not add_to_list()']);
    expect(err('@button(counts_as="Gone")\ndef button():\n    "X"')).toEqual([1, 'there is no outcome called "Gone"']);
    expect(err('@button(color="pink", counts_as="no_answer")\ndef button():\n    "X"')?.[1]).toMatch(/^color= is one of "default", "gray"/);
    expect(err('@button(counts_as="no_appt")\ndef button():\n    "X"', ButtonDef.parse({ id: 'no_answer', outcome: 'no_answer', label: 'Dial: No answer' })))
      .toEqual([1, "this is Dial: No answer's own button: it always counts as that"]);
    expect(err('def button():\n    "X"')?.[1]).toMatch(/say what it counts as/);
    expect(err('@button(counts_as="no_answer")\ndef button():\n    ""')?.[1]).toBe('give the button a name');
  });
});
