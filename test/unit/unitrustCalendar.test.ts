import { describe, it, expect, beforeAll } from 'vitest';
import { parseUnitrustTitle } from '../../src/shared/appointments.js';

// The extension's page reader (extension/unitrust/calendar.js) sets globalThis.MpcrmCalendar.
interface Reader {
  extractTitle(t: string): string | null;
  classifyColor(css: string): string | null;
  dateFor(month: number, day: number, today: Date): string;
  timeAt(top: number, hours: { top: number; hour: number }[]): string | null;
}
let cal: Reader;
beforeAll(async () => {
  // @ts-expect-error plain browser script with no types
  await import('../../extension/unitrust/calendar.js');
  cal = (globalThis as unknown as { MpcrmCalendar: Reader }).MpcrmCalendar;
});

describe('Unitrust appointment titles', () => {
  it('reads state, lender, name and phone', () => {
    expect(parseUnitrustTitle('OH - UNION SAVING - CALEB BRIGLE- (614) 706-9261 BRIGLE')).toEqual({ state: 'OH', lender: 'UNION SAVING', name: 'CALEB BRIGLE', phone: '6147069261' });
    expect(parseUnitrustTitle('IN - NOTRE DAME F - GISELE UMUGWANEZA- (574) 201-2767 Umugwaneza')?.name).toBe('GISELE UMUGWANEZA');
    // A mistyped number in Unitrust still gives a key.
    expect(parseUnitrustTitle('OH - KEMBA FINANC - SHAUNA BOYD- (161) 437-48971 BOYD')?.phone).toBe('16143748971');
  });

  it('leaves out your own events', () => {
    expect(parseUnitrustTitle('DONT BOOK! CHURCH')).toBeNull();
    expect(parseUnitrustTitle('NILES RADCLIFF (MARRIED)')).toBeNull();
    expect(parseUnitrustTitle('Dinner at vineyard')).toBeNull();
  });

  it('the extension finds the title inside longer text, the same way', () => {
    const t = cal.extractTitle('10:00 AM  IN - RUOFF MORTGA - BRIAN ANDRADE- (574) 333-4998 ANDRADE');
    expect(t).toBe('IN - RUOFF MORTGA - BRIAN ANDRADE- (574) 333-4998 ANDRADE');
    expect(parseUnitrustTitle(t!)?.phone).toBe('5743334998');
    expect(cal.extractTitle('Dinner at vineyard')).toBeNull();
  });
});

describe('the extension reads colors, days and times', () => {
  it('colors', () => {
    expect(cal.classifyColor('rgb(66, 133, 244)')).toBe('blue');
    expect(cal.classifyColor('rgb(52, 168, 83)')).toBe('green');
    expect(cal.classifyColor('rgb(234, 67, 53)')).toBe('red');
    expect(cal.classifyColor('rgb(251, 188, 5)')).toBe('yellow');
    expect(cal.classifyColor('rgb(255, 255, 255)')).toBeNull();
    expect(cal.classifyColor('rgb(128, 128, 128)')).toBeNull();
    expect(cal.classifyColor('rgba(0, 0, 0, 0)')).toBeNull();
  });

  it('days without a year land closest to today', () => {
    expect(cal.dateFor(10, 26, new Date(2026, 9, 28))).toBe('2026-10-26');
    expect(cal.dateFor(1, 2, new Date(2026, 11, 30))).toBe('2027-01-02');
    expect(cal.dateFor(12, 30, new Date(2027, 0, 2))).toBe('2026-12-30');
  });

  it('times from the hour labels, to the quarter hour', () => {
    const hours = [7, 8, 9, 10].map((h, i) => ({ top: 100 + i * 60, hour: h }));
    expect(cal.timeAt(100, hours)).toBe('07:00');
    expect(cal.timeAt(190, hours)).toBe('08:30');
    expect(cal.timeAt(280, hours)).toBe('10:00');
    expect(cal.timeAt(100, [])).toBeNull();
  });
});
