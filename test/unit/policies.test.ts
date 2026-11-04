import { describe, it, expect, beforeAll } from 'vitest';
import { commissionCents, policyStage } from '../../src/shared/policies.js';
import { parseDay, parseMoney, levelOn, type CompLevel } from '../../src/server/domain/policies.js';

// The extension's report reader (extension/unitrust/business.js) sets globalThis.MpcrmBusiness.
interface Reader {
  columnsFrom(headers: { text: string; left: number; right: number }[], groups: { text: string; left: number }[]): Record<string, { left: number; right: number }>;
  cardFields(tokens: string[]): Record<string, string | number>;
}
let br: Reader;
beforeAll(async () => {
  // @ts-expect-error plain browser script with no types
  await import('../../extension/unitrust/business.js');
  br = (globalThis as unknown as { MpcrmBusiness: Reader }).MpcrmBusiness;
});

describe('commission', () => {
  it('is AP × (level − comp hit) × advance', () => {
    // Americo Term 100 at level 70 with a 10 point hit and a 75% advance.
    expect(commissionCents(66348, 70, { comp_hit_points: 10, advance_pct: 75 })).toBe(29857);
    // Level comp.
    expect(commissionCents(100000, 75, { comp_hit_points: 0, advance_pct: 75 })).toBe(56250);
    // Never below zero.
    expect(commissionCents(100000, 5, { comp_hit_points: 10, advance_pct: 75 })).toBe(0);
  });

  it('is unknown until the rules and the level are set', () => {
    expect(commissionCents(100000, 70, { comp_hit_points: null, advance_pct: 75 })).toBeNull();
    expect(commissionCents(100000, 70, { comp_hit_points: 0, advance_pct: null })).toBeNull();
    expect(commissionCents(100000, null, { comp_hit_points: 0, advance_pct: 75 })).toBeNull();
    expect(commissionCents(null, 70, { comp_hit_points: 0, advance_pct: 75 })).toBeNull();
  });
});

describe('Unitrust statuses', () => {
  it('only paid ones count; not-paid and in-progress ones are pending; declined ones are out', () => {
    expect(policyStage('Issue-Paid')).toEqual({ stage: 'paid', known: true });
    expect(policyStage('Lapsed')).toEqual({ stage: 'paid', known: true });
    expect(policyStage('Issued Not Paid')).toEqual({ stage: 'pending', known: true });
    expect(policyStage('Initial Premium Not Paid')).toEqual({ stage: 'pending', known: true });
    expect(policyStage('Submitted')).toEqual({ stage: 'pending', known: true });
    expect(policyStage('Declined')).toEqual({ stage: 'out', known: true });
    expect(policyStage('Withdrawn')).toEqual({ stage: 'out', known: true });
    expect(policyStage('Something new')).toEqual({ stage: 'pending', known: false });
  });
});

describe('reading the report', () => {
  it('money and dates as the page shows them', () => {
    expect(parseMoney('$1,036.68')).toBe(103668);
    expect(parseMoney('—')).toBeNull();
    expect(parseDay('11/03/2026')).toBe('2026-11-03');
    expect(parseDay('1/3/26')).toBe('2026-01-03');
    expect(parseDay('—')).toBeNull();
  });

  it('the comp level on a day', () => {
    const l = (level: number, effective_from: string) => ({ level, effective_from }) as CompLevel;
    const levels = [l(70, '2026-05-01'), l(75, '2026-12-01')];
    expect(levelOn(levels, '2026-11-03')).toBe(70);
    expect(levelOn(levels, '2026-12-01')).toBe(75);
    // Before the first level you set: the oldest one.
    expect(levelOn(levels, '2026-01-01')).toBe(70);
    expect(levelOn([], '2026-01-01')).toBeNull();
  });

  it('List View: the client phone and premium amount are told apart from the agent phone and coverage amount by their group', () => {
    const h = (text: string, left: number) => ({ text, left, right: left + 100 });
    const cols = br.columnsFrom(
      [h('Client Name', 100), h('Phone', 400), h('Phone', 600), h('Insurance Co.', 700), h('Amount', 1000), h('Amount', 1100), h('Capped', 1200), h('Status', 1400)],
      [{ text: 'Pinned', left: 0 }, { text: 'Agent', left: 300 }, { text: 'Client Info', left: 600 }, { text: 'Application Info', left: 700 },
        { text: 'Premium', left: 1000 }, { text: 'Coverage', left: 1100 }, { text: 'APV', left: 1200 }, { text: 'Status', left: 1400 }],
    );
    expect(cols.client_phone!.left).toBe(600);
    expect(cols.premium!.left).toBe(1000);
    expect(cols.carrier!.left).toBe(700);
    expect(cols.status!.left).toBe(1400);
  });

  it('Card View: each label takes the values after it; labels side by side take one each', () => {
    const p = br.cardFields([
      'UFG App ID', 'Uni-100002', 'Carrier Policy Number', 'TEST000002',
      'Agent', 'Agent Name', 'UFG000001', 'IN', 'Lv. 70', '(312) 555-0100',
      'Client', '900000001', 'Chris Example', '(312) 555-0145', 's@x.com', 'DOB', '01/01/1980', 'City · State', 'SPRINGFIELD - IL',
      'Company', 'AMERICAN AMICABLE', 'Product', 'Home Certainty',
      'Premium', '$86.39', 'Monthly', 'APV', 'Capped', '$1,036.68', '$1,000.00',
      'Viewed by Client', 'Status', '• Issue-Paid', 'Bonusable app.', 'Application', '11/03/2026', 'Paid', '11/03/2026', 'Lapsed', '—',
    ]);
    expect(p).toMatchObject({
      app_id: 'Uni-100002', policy_number: 'TEST000002', client_name: 'Chris Example', client_phone: '(312) 555-0145',
      carrier: 'AMERICAN AMICABLE', product: 'Home Certainty', premium: '$86.39', apv: '$1,036.68', capped_apv: '$1,000.00',
      status: 'Issue-Paid', applied: '11/03/2026', paid: '11/03/2026', agent_id: 'UFG000001', level: 70,
    });
  });
});
