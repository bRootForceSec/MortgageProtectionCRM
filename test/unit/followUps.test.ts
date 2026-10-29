import { describe, it, expect } from 'vitest';
import { afterStep, isStep, parsePlan } from '../../src/shared/followUps.js';

describe('follow-up steps', () => {
  it('reads minutes, hours, days and a day at a time', () => {
    expect(['15m', '2h', '3d', '1d@09:00'].every(isStep)).toBe(true);
    expect(['15', '2h@09:00', '1d@25:00', 'tomorrow', ''].some(isStep)).toBe(false);
    expect(parsePlan(' 15M, 1d@09:00 ,3d ')).toEqual(['15m', '1d@09:00', '3d']);
    expect(parsePlan('')).toEqual([]);
    expect(parsePlan('15m, soon')).toBeNull();
  });

  it('counts from the given time; "@" moves to that time of day in your time', () => {
    const from = new Date(2026, 9, 17, 14, 30).toISOString();
    expect(afterStep(from, '15m')).toBe(new Date(2026, 9, 17, 14, 45).toISOString());
    expect(afterStep(from, '2h')).toBe(new Date(2026, 9, 17, 16, 30).toISOString());
    expect(afterStep(from, '3d')).toBe(new Date(2026, 9, 20, 14, 30).toISOString());
    expect(afterStep(from, '1d@09:00')).toBe(new Date(2026, 9, 18, 9, 0).toISOString());
  });
});
