import { describe, it, expect } from 'vitest';
import { BestTimeRules, STARTER_BEST_TIME, bestTimeFirst, bestTimeScore, bestTimeWords, localNow } from '../../src/shared/bestTime.js';

const MIN_ATTEMPTS = STARTER_BEST_TIME.min_calls;

// Thursday 2026-10-29, 22:30 UTC: 6:30 PM in New York, 3:30 PM in Los Angeles, 5:30 PM in Chicago.
const NOW = new Date('2026-10-29T22:30:00Z');

describe('best time first', () => {
  it('reads the weekday and hour where the lead is', () => {
    expect(localNow('America/New_York', NOW)).toEqual({ weekday: 4, hour: 18 });
    expect(localNow('America/Los_Angeles', NOW)).toEqual({ weekday: 4, hour: 15 });
  });

  it('uses your own pickup rate once there are enough calls, else the usual curve; too late goes last', () => {
    expect(bestTimeScore({}, 'America/New_York', NOW)).toBe(0.3);
    expect(bestTimeScore({}, 'America/Los_Angeles', NOW)).toBe(0.2);
    expect(bestTimeScore({ '4:15': { attempts: MIN_ATTEMPTS, pickups: 5 } }, 'America/Los_Angeles', NOW)).toBe(0.5);
    expect(bestTimeScore({ '4:15': { attempts: MIN_ATTEMPTS - 1, pickups: 9 } }, 'America/Los_Angeles', NOW)).toBe(0.2);
    expect(bestTimeScore({}, 'America/New_York', new Date('2026-10-30T01:30:00Z'))).toBe(-1); // 9:30 PM
    expect(bestTimeScore({}, 'America/New_York', new Date('2026-10-29T11:30:00Z'))).toBe(-1); // 7:30 AM
  });

  it('follows your calling hours and call count, and says so in words', () => {
    const mine = { min_calls: 3, from_hour: 9, to_hour: 18 };
    expect(bestTimeScore({}, 'America/New_York', NOW, mine)).toBe(-1); // 6:30 PM is past 6 PM
    expect(bestTimeScore({ '4:15': { attempts: 3, pickups: 3 } }, 'America/Los_Angeles', NOW, mine)).toBe(1);
    expect(bestTimeWords(mine)).toMatch(/fewer than 3 calls.*before 9 AM or from 6 PM on go last/);
    expect(bestTimeWords()).toMatch(/before 8 AM or from 9 PM on/);
    expect(BestTimeRules.safeParse({ min_calls: 10, from_hour: 20, to_hour: 9 }).success).toBe(false);
  });

  it('orders the leads still to call by score, keeping ties in order, then the worked ones', () => {
    const item = (id: string, time_zone: string, done: unknown = null) => ({ id, time_zone, done });
    const list = [item('la1', 'America/Los_Angeles'), item('ny-done', 'America/New_York', { label: 'x' }), item('ny', 'America/New_York'), item('la2', 'America/Los_Angeles'), item('chi', 'America/Chicago')];
    expect(bestTimeFirst(list, {}, NOW).map((i) => i.id)).toEqual(['ny', 'chi', 'la1', 'la2', 'ny-done']);
  });
});
