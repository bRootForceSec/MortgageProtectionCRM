import { describe, it, expect } from 'vitest';
import { FormulaError, parseFormula, renameFormulaField } from '../../src/shared/formula.js';
import { emptyGroup, formulaToPython, toForm, toPython, type CondGroup } from '../../src/shared/condition.js';

describe('Python syntax in formulas', () => {
  it('reads ==, True, field("Name"), x if test else y, keyword arguments and # comments', () => {
    expect(parseFormula('field("Score") == 3 # the score')).toEqual({ t: 'bin', op: '=', l: { t: 'field', label: 'Score' }, r: { t: 'num', v: 3 } });
    expect(parseFormula('1 if has("Hot") else 2')).toMatchObject({ t: 'call', name: 'if', args: [{ t: 'call', name: 'has' }, { t: 'num', v: 1 }, { t: 'num', v: 2 }] });
    expect(parseFormula('times("No answer", days=7)')).toEqual({ t: 'call', name: 'times', args: [{ t: 'str', v: 'No answer' }, { t: 'num', v: 7 }] });
    expect(parseFormula('pressed(days=3, outcome="x")')).toEqual({ t: 'call', name: 'pressed', args: [{ t: 'str', v: 'x' }, { t: 'num', v: 3 }] });
    expect(parseFormula('True and not False')).toMatchObject({ t: 'bin', op: 'and', l: { t: 'bool', v: true }, r: { t: 'not' } });
    // The formula's own = still compares, also inside if().
    expect(parseFormula('if(state = "OH", 1, 0)')).toMatchObject({ t: 'call', name: 'if', args: [{ t: 'bin', op: '=' }, { t: 'num', v: 1 }, { t: 'num', v: 0 }] });
    const err = (src: string) => { try { parseFormula(src); return null; } catch (e) { return (e as FormulaError).message; } };
    expect(err('times(days=7)')).toMatch(/missing a value/);
    expect(err('times("a", days=1, days=2)')).toMatch(/given twice/);
    expect(err('1 if has("x")')).toMatch(/else/);
    expect(err('field(3)')).toMatch(/field\(\) takes/);
  });

  it('renaming a field rewrites field("Old") as well as [Old]', () => {
    expect(renameFormulaField('field("score") + [Score] + field(\'Other\')', 'Score', 'Lead score')).toBe('field("Lead score") + [Lead score] + field(\'Other\')');
  });

  it('writes any formula back as Python, keeping the meaning', () => {
    for (const f of ['if(age > 70, 3, 2)', '(1 + 2) * 3', '10 - (4 - 1)', 'not (has("A") or [Smoker?])', '-(age - 1)', 'times("x", 7) >= 2']) {
      const py = formulaToPython(parseFormula(f));
      expect(parseFormula(py)).toEqual(parseFormula(f));
    }
    expect(formulaToPython(parseFormula('if(age > 70, 3, 2)'))).toBe('3 if age > 70 else 2');
    expect(formulaToPython(parseFormula('times("x", 7) >= 2'))).toBe('times("x", days=7) >= 2');
  });
});

describe('the condition form', () => {
  it('reads Python into rows and groups, and writes the same text back', () => {
    const src = 'has("No show") and hours_since(added("No show")) < 72 and before("Appt set", "No show") and not (times("No answer", days=7) >= 3 or pressed("Bad number") >= 1) and (state == "OH" or field("Score") > 50)';
    const g = toForm(src);
    expect(g.mode).toBe('all');
    expect(g.items.map((i) => i.kind)).toEqual(['has', 'since', 'before', 'group', 'group']);
    expect(g.items[3]).toMatchObject({ kind: 'group', mode: 'any', negate: true, items: [{ kind: 'times', days: 7, op: '>=', n: 3 }, { kind: 'pressed', outcome: 'Bad number' }] });
    expect(g.items[4]).toMatchObject({ items: [{ kind: 'value', name: 'state', op: '==', value: 'OH' }, { kind: 'field', label: 'Score', op: '>', value: 50 }] });
    expect(toPython(g)).toBe(src);
  });

  it('keeps what the rows cannot show as a Python row, and an empty form is every lead', () => {
    const g = toForm('attempts * 2 > age / 10 and not has("Sold")');
    expect(g.items).toEqual([{ kind: 'python', code: 'attempts * 2 > age / 10' }, { kind: 'has', tag: 'Sold', negate: true }]);
    expect(toPython(g)).toBe('attempts * 2 > age / 10 and not has("Sold")');
    expect(toPython(emptyGroup())).toBe('True');
    expect(toForm('')).toEqual(emptyGroup());
    // A Python row with an or of its own gets brackets next to other rows.
    const mixed: CondGroup = { kind: 'group', mode: 'all', negate: false, items: [{ kind: 'python', code: 'has("A") or has("B")' }, { kind: 'has', tag: 'C', negate: false }] };
    expect(toPython(mixed)).toBe('(has("A") or has("B")) and has("C")');
    expect(() => toForm('has(')).toThrow(FormulaError);
  });
});

describe('status rows', () => {
  it('reads status("Name") and in_list("Name"), and writes in_list', () => {
    const g = toForm('status("Needs rebook") and not in_list("Client")');
    expect(g.items).toEqual([{ kind: 'status', name: 'Needs rebook', negate: false }, { kind: 'status', name: 'Client', negate: true }]);
    expect(toPython(g)).toBe('in_list("Needs rebook") and not in_list("Client")');
  });
});
