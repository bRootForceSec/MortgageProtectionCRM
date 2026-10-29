import { describe, it, expect } from 'vitest';
import { ageBand, leadAgeDays } from '../../src/shared/leadAge.js';

describe('lead age', () => {
  it('counts whole days since the call-in date, and puts them in bands', () => {
    expect(leadAgeDays('2026-10-01T15:00:00.000Z', '2026-10-08T14:59:00.000Z')).toBe(6);
    expect(leadAgeDays('2026-10-01T15:00:00.000Z', '2026-10-08T15:00:00.000Z')).toBe(7);
    expect(leadAgeDays(null)).toBeNull();
    expect([0, 7, 8, 30, 31, 90, 91, 400].map(ageBand)).toEqual(['0_7', '0_7', '8_30', '8_30', '31_90', '31_90', 'older', 'older']);
    expect(ageBand(null)).toBeNull();
  });
});
