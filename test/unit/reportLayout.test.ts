import { describe, it, expect } from 'vitest';
import { REPORT_CARDS, cardView, fullLayout } from '../../src/shared/reportLayout.js';

describe('Reports layout', () => {
  it('starts with every card in the default order, By lead age hidden', () => {
    const l = fullLayout([]);
    expect(l.map((c) => c.key)).toEqual(Object.keys(REPORT_CARDS));
    expect(l.filter((c) => c.hidden).map((c) => c.key)).toEqual(['by_age']);
  });

  it('keeps your order, drops unknown and repeated cards, and adds cards you never placed at the end', () => {
    const l = fullLayout([{ key: 'weekly', hidden: false }, { key: 'nope', hidden: false }, { key: 'activity', hidden: true }, { key: 'weekly', hidden: true }]);
    expect(l.slice(0, 2)).toEqual([{ key: 'weekly', hidden: false }, { key: 'activity', hidden: true }]);
    expect(l).toHaveLength(Object.keys(REPORT_CARDS).length);
    expect(l.find((c) => c.key === 'by_age')?.hidden).toBe(true);
  });

  it('shows a card as a chart or a table only where it has both', () => {
    expect(cardView({ key: 'by_hour', hidden: false })).toBe('chart');
    expect(cardView({ key: 'by_hour', hidden: false, view: 'table' })).toBe('table');
    expect(cardView({ key: 'activity', hidden: false, view: 'table' })).toBeNull();
  });
});
