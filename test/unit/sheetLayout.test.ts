import { describe, it, expect } from 'vitest';
import { LEAD_FACTS, SheetLayout, SHEET_BLOCKS, sheetBlocks, sheetFacts } from '../../src/shared/sheetLayout.js';
import { CallingSettings } from '../../src/shared/callingSettings.js';

describe('the lead sheet blocks', () => {
  it('starts with every block shown, in the order the screen has always had', () => {
    expect(sheetBlocks(undefined)).toEqual(SHEET_BLOCKS.map((b) => ({ id: b.id, shown: true })));
    const s = CallingSettings.parse({}).sheet;
    expect(s).toEqual({ blocks: [], facts: [], calls_shown: 0, notes_rows: 2, dial_counter: true, caller_id: true });
    expect(CallingSettings.parse({}).sheet_layouts).toEqual([]);
  });

  it('keeps your order, adds blocks you never placed at the end, and never hides the outcome buttons', () => {
    const layout = SheetLayout.parse({ blocks: [{ id: 'notes', shown: true }, { id: 'outcome', shown: false }, { id: 'calls', shown: false }, { id: 'notes', shown: false }] });
    expect(sheetBlocks(layout)).toEqual([
      { id: 'notes', shown: true },
      { id: 'outcome', shown: true },
      { id: 'calls', shown: false },
      { id: 'lead', shown: true },
      { id: 'tags', shown: true },
    ]);
  });

  it('refuses a block it does not know', () => {
    expect(() => SheetLayout.parse({ blocks: [{ id: 'weather', shown: true }] })).toThrow();
  });

  it('Lead info: every fact in the usual order, then your fields; your order and hidden ones kept; gone fields dropped', () => {
    expect(sheetFacts(undefined, ['f1'])).toEqual([...LEAD_FACTS.map((f) => ({ id: f.id, shown: true })), { id: 'field:f1', shown: true }]);
    const layout = SheetLayout.parse({ facts: [{ id: 'field:f1', shown: true }, { id: 'tobacco', shown: false }, { id: 'field:gone', shown: true }] });
    const out = sheetFacts(layout, ['f1', 'f2']);
    expect(out.slice(0, 2)).toEqual([{ id: 'field:f1', shown: true }, { id: 'tobacco', shown: false }]);
    expect(out.map((f) => f.id)).not.toContain('field:gone');
    expect(out.at(-1)).toEqual({ id: 'field:f2', shown: true });
    expect(out).toHaveLength(LEAD_FACTS.length + 2);
  });

  it('saved lead sheets need different names', () => {
    const sheet = SheetLayout.parse({});
    expect(CallingSettings.safeParse({ sheet_layouts: [{ name: 'New leads', sheet }, { name: 'Appts', sheet }] }).success).toBe(true);
    expect(CallingSettings.safeParse({ sheet_layouts: [{ name: 'New leads', sheet }, { name: 'new leads', sheet }] }).success).toBe(false);
  });
});
