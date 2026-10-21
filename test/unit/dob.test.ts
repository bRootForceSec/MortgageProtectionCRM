import { describe, it, expect } from 'vitest';
import { normalizeDob } from '../../src/server/domain/normalize.js';
import { ageOn } from '../../src/shared/age.js';
import { mapFields } from '../../src/server/domain/importer.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';

const NOW = new Date(2026, 9, 19); // Oct 19, 2026

describe('date of birth', () => {
  it.each([
    ['3/14/1961', '1961-03-14'],
    ['03-14-61', '1961-03-14'],
    ['1/2/05', '2005-01-02'],
    ['1961-03-14', '1961-03-14'],
    ['March 14, 1961', '1961-03-14'],
    ['14 Mar 1961', '1961-03-14'],
    ['Mar 14th, 1961', '1961-03-14'],
  ])('%s → %s', (raw, iso) => expect(normalizeDob(raw, NOW).value).toBe(iso));

  it('rejects dates that are not real or out of range, with a reason', () => {
    expect(normalizeDob('2/30/1961', NOW).problem).toMatch(/not understood/);
    expect(normalizeDob('someday', NOW).problem).toMatch(/not understood/);
    expect(normalizeDob('1/1/2020', NOW).problem).toMatch(/out of range/);
    expect(normalizeDob('', NOW)).toEqual({ value: null });
  });

  it('age counts whole years, turning over on the birthday', () => {
    expect(ageOn('1961-10-19', NOW)).toBe(65);
    expect(ageOn('1961-10-20', NOW)).toBe(64);
  });

  it('import: age comes from the date of birth, and a printed age that disagrees is flagged', () => {
    const dob = '1/1/1970';
    const expected = ageOn('1970-01-01');
    const ok = mapFields({ full_name: 'Jane Doe', phone: '6145550101', dob, age: String(expected) });
    expect(ok.lead).toMatchObject({ dob: '1970-01-01', dob_raw: dob, age: expected });
    expect(ok.warnings).toEqual([]);
    const off = mapFields({ full_name: 'Jane Doe', phone: '6145550101', dob, age: '30' });
    expect(off.lead.age).toBe(expected);
    expect(off.lead.age_raw).toBe('30');
    expect(off.warnings.join(' ')).toMatch(/doesn't match the date of birth/);
  });

  it('spreadsheet columns named DOB or Date of Birth are mapped', () => {
    expect(suggestMapping(['Name', 'Phone', 'DOB']).dob).toBe('DOB');
    expect(suggestMapping(['Name', 'Phone', 'Date of Birth']).dob).toBe('Date of Birth');
    expect(suggestMapping(['Name', 'Phone', 'Birthdate']).dob).toBe('Birthdate');
  });
});
