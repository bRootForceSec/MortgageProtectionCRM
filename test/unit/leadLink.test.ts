import { describe, it, expect, beforeAll } from 'vitest';
import { isLeadId, leadIdInText, leadLink } from '../../src/shared/leadLink.js';

const ID = '019a1f2e-3b4c-7d5e-8f60-123456789abc';
let extensionReads: (text: string) => string | null;
beforeAll(async () => {
  // @ts-expect-error plain browser script with no types
  await import('../../extension/unitrust/calendar.js');
  extensionReads = (globalThis as unknown as { MpcrmCalendar: { leadIdIn(t: string): string | null } }).MpcrmCalendar.leadIdIn;
});

describe('lead links', () => {
  it('a copied link points back to its lead', () => {
    const link = leadLink('http://127.0.0.1:5170', ID);
    expect(link).toBe(`http://127.0.0.1:5170/lead/${ID}`);
    expect(leadIdInText(link)).toBe(ID);
    expect(isLeadId(ID)).toBe(true);
    expect(isLeadId('../etc')).toBe(false);
  });

  it('finds the link inside notes, and in the page address', () => {
    expect(leadIdInText(`Booked by me. CRM: http://127.0.0.1:5170/lead/${ID.toUpperCase()} call 10 min early`)).toBe(ID);
    expect(leadIdInText(`#lead/${ID}`)).toBe(ID);
    expect(leadIdInText('calling')).toBeNull();
    expect(leadIdInText('(614) 555-0102')).toBeNull();
    expect(leadIdInText(null)).toBeNull();
  });

  it('the Unitrust extension reads the same links', () => {
    expect(extensionReads(`OH - CHASE - ROBERT RAY- (614) 555-0102 RAY http://127.0.0.1:5170/lead/${ID}`)).toBe(ID);
    expect(extensionReads('OH - CHASE - ROBERT RAY- (614) 555-0102 RAY')).toBeNull();
  });
});
