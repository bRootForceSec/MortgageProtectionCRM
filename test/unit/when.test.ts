import { describe, it, expect } from 'vitest';
import { parseDay, parseTime, readCallback, callbackFields } from '../../src/web/when.js';

// Saturday Oct 17 2026, 3:10 PM local.
const now = new Date(2026, 9, 17, 15, 10);
const ymd = (d: Date | null) => (d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : null);

describe('callback picker', () => {
  it('reads days', () => {
    expect(ymd(parseDay('t', now))).toBe('2026-10-17');
    expect(ymd(parseDay('m', now))).toBe('2026-10-18');
    expect(ymd(parseDay('Tomorrow', now))).toBe('2026-10-18');
    expect(ymd(parseDay('mon', now))).toBe('2026-10-19');
    expect(ymd(parseDay('fri', now))).toBe('2026-10-23');
    expect(ymd(parseDay('sat', now))).toBe('2026-10-24'); // next Saturday, not today
    expect(ymd(parseDay('10/24', now))).toBe('2026-10-24');
    expect(ymd(parseDay('1/5', now))).toBe('2027-1-5'); // passed this year: next year
    expect(ymd(parseDay('2026-11-02', now))).toBe('2026-11-2');
    expect(parseDay('2/30', now)).toBeNull();
    expect(parseDay('xyz', now)).toBeNull();
    expect(parseDay('', now)).toBeNull();
  });

  it('reads times, taking 1 to 7 without AM/PM as afternoon', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('2')).toBe(14 * 60);
    expect(parseTime('2:30')).toBe(14 * 60 + 30);
    expect(parseTime('230p')).toBe(14 * 60 + 30);
    expect(parseTime('10am')).toBe(10 * 60);
    expect(parseTime('9')).toBe(9 * 60);
    expect(parseTime('12')).toBe(12 * 60);
    expect(parseTime('12am')).toBe(0);
    expect(parseTime('14:30')).toBe(14 * 60 + 30);
    expect(parseTime('1030')).toBe(10 * 60 + 30);
    expect(parseTime('2:30 PM')).toBe(14 * 60 + 30);
    expect(parseTime('25')).toBeNaN();
    expect(parseTime('soon')).toBeNaN();
  });

  it('makes a callback for a day with no time, or a day and time', () => {
    const any = readCallback('m', '', now);
    expect(any).toEqual({ at: new Date(2026, 9, 18), anyTime: true });
    const timed = readCallback('t', '4', now);
    expect(timed).toEqual({ at: new Date(2026, 9, 17, 16, 0), anyTime: false });
    expect(readCallback('t', '9am', now)).toMatchObject({ error: expect.stringMatching(/passed/) });
    expect(readCallback('', '', now)).toMatchObject({ error: expect.any(String) });
    expect(readCallback('m', 'later', now)).toMatchObject({ error: expect.any(String) });
  });

  it('puts a saved callback back into the fields after an undo', () => {
    const f = callbackFields(new Date(2026, 9, 18, 14, 30).toISOString(), false);
    expect(readCallback(f.day, f.time, now)).toEqual({ at: new Date(2026, 9, 18, 14, 30), anyTime: false });
    const g = callbackFields(new Date(2026, 9, 18).toISOString(), true);
    expect(g.time).toBe('');
    expect(readCallback(g.day, g.time, now)).toEqual({ at: new Date(2026, 9, 18), anyTime: true });
  });
});

describe('callback picker in the lead\'s time zone', () => {
  const hourIn = (d: Date, tz: string) => d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });

  it('reads a typed time as the lead\'s own time', () => {
    for (const tz of ['America/Chicago', 'America/New_York', 'America/Los_Angeles']) {
      const cb = readCallback('m', '2', now, tz);
      if ('error' in cb) throw new Error(cb.error);
      expect(hourIn(cb.at, tz)).toBe('2:00 PM');
      expect(cb.anyTime).toBe(false);
    }
  });

  it('keeps "any time" as the start of your day', () => {
    const cb = readCallback('m', '', now, 'America/Chicago');
    if ('error' in cb) throw new Error(cb.error);
    expect(cb.anyTime).toBe(true);
    expect(cb.at.getHours()).toBe(0);
  });

  it('puts an undone callback back in the lead\'s time', () => {
    const cb = readCallback('m', '2:30', now, 'America/Chicago');
    if ('error' in cb) throw new Error(cb.error);
    expect(callbackFields(cb.at.toISOString(), false, 'America/Chicago').time).toBe('2:30pm');
  });

  it('handles the day clocks change', () => {
    // Nov 1 2026: US clocks go back an hour.
    const cb = readCallback('11/1', '10am', now, 'America/Chicago');
    if ('error' in cb) throw new Error(cb.error);
    expect(hourIn(cb.at, 'America/Chicago')).toBe('10:00 AM');
  });
});
