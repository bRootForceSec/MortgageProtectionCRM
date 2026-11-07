import { describe, it, expect } from 'vitest';
import { yourOrder, describeSortStep, STARTER_ORDER, type SortStep } from '../../src/shared/listOrder.js';

const item = (id: string, keys: (number | null)[], more: { done?: boolean; tz?: string } = {}) => ({
  id, done: more.done ? {} : null, time_zone: more.tz ?? 'America/New_York', sort_keys: keys,
});
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('your call list order', () => {
  const num: SortStep = { by: 'formula', formula: 'loan_amount', lowest_first: false };

  it('sorts by the first step that tells leads apart, leaves no value and worked leads last, and keeps ties in list order', () => {
    const yes: SortStep = { by: 'formula', formula: 'has("Hot")', lowest_first: false };
    const list = [item('a', [0, 5]), item('b', [1, null]), item('w', [1, 9], { done: true }), item('c', [0, 9]), item('d', [1, 2]), item('e', [0, 5])];
    expect(ids(yourOrder(list, [yes, num], {}))).toEqual(['d', 'b', 'c', 'a', 'e', 'w']);
    expect(ids(yourOrder(list, [yes, { ...num, lowest_first: true }], {}))).toEqual(['d', 'b', 'a', 'e', 'c', 'w']);
    expect(ids(yourOrder(list, [], {}))).toEqual(['a', 'b', 'c', 'd', 'e', 'w']);
  });

  it('best time now uses the hour where the lead is: out of hours goes last', () => {
    const now = new Date('2026-03-04T23:00:00Z'); // 6 PM in New York, 3 PM in Los Angeles, midnight in London
    const list = [item('london', [null], { tz: 'Europe/London' }), item('la', [null], { tz: 'America/Los_Angeles' }), item('ny', [null])];
    expect(ids(yourOrder(list, [{ by: 'best_time' }], {}, now))).toEqual(['ny', 'la', 'london']);
  });

  it('says what each step does', () => {
    expect(STARTER_ORDER.map(describeSortStep)).toEqual(['appt_result == "no_show" or appt_result == "sat_no_sale" or appt_result == "prezi"', 'Best time to call now']);
    expect(describeSortStep({ ...num, lowest_first: true })).toBe('loan_amount (lowest first)');
  });
});
