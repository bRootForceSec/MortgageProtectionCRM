import { describe, it, expect } from 'vitest';
import { SheetLayout, SHEET_BLOCKS, sheetBlocks } from '../../src/shared/sheetLayout.js';
import { CallingSettings } from '../../src/shared/callingSettings.js';

describe('the lead sheet blocks', () => {
  it('starts with every block shown, in the order the screen has always had', () => {
    expect(sheetBlocks(undefined)).toEqual(SHEET_BLOCKS.map((b) => ({ id: b.id, shown: true })));
    const s = CallingSettings.parse({}).sheet;
    expect(s).toEqual({ blocks: [], dial_counter: true, caller_id: true });
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
});
