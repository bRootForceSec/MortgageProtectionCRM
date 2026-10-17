import { describe, it, expect } from 'vitest';
import {
  normalizeUsPhone, normalizeMoneyToCents, normalizeAge, coborrowerSignal, normalizeState, normalizeZip, splitName,
} from '../../src/server/domain/normalize.js';
import { suggestMapping, validateMapping } from '../../src/server/domain/mapping.js';

describe('phone normalization', () => {
  it.each([
    ['(614) 555-0101', '+16145550101'],
    ['614.555.0101', '+16145550101'],
    ['1-614-555-0101', '+16145550101'],
    ['+1 614 555 0101', '+16145550101'],
    [6145550101, '+16145550101'],
  ])('%s → %s', (raw, e164) => expect(normalizeUsPhone(raw).value).toBe(e164));

  it.each(['555-01', '014-555-0101', '614-155-0101', '5555555555', '614-555-0101 x22'])('rejects %s with a reason', (raw) => {
    const r = normalizeUsPhone(raw);
    expect(r.value).toBeNull();
    expect(r.problem).toBeTruthy();
  });

  it('blank is not an error', () => expect(normalizeUsPhone('  ')).toEqual({ value: null }));
});

describe('other fields', () => {
  it('money', () => {
    expect(normalizeMoneyToCents('$286,000').value).toBe(28_600_000);
    expect(normalizeMoneyToCents('320k').value).toBe(32_000_000);
    expect(normalizeMoneyToCents(175000).value).toBe(17_500_000);
    expect(normalizeMoneyToCents('lots').problem).toMatch(/not understood/);
  });
  it('age', () => {
    expect(normalizeAge('52').value).toBe(52);
    expect(normalizeAge('52 yrs').value).toBe(52);
    expect(normalizeAge('forty').problem).toBeTruthy();
    expect(normalizeAge('3').problem).toMatch(/range/);
  });
  it('co-borrower "no" is unknown, not no', () => {
    expect(coborrowerSignal('Yes')).toBe('yes');
    expect(coborrowerSignal('No')).toBe('unknown');
    expect(coborrowerSignal('')).toBe('unknown');
  });
  it('state and zip', () => {
    expect(normalizeState('ohio').value).toBe('OH');
    expect(normalizeState('OH').value).toBe('OH');
    expect(normalizeState('Narnia').problem).toBeTruthy();
    expect(normalizeZip('43215-1234').value).toBe('43215');
    expect(normalizeZip('2108').value).toBe('02108');
  });
  it('names', () => {
    expect(splitName('Doe, Jane')).toEqual({ first: 'Jane', last: 'Doe' });
    expect(splitName('Mary Ann Smith')).toEqual({ first: 'Mary Ann', last: 'Smith' });
  });
});

describe('column mapping', () => {
  it('guesses common headers', () => {
    const m = suggestMapping(['Lead Name', 'Phone #', 'Lender', 'Loan Amt', 'Age', 'Co-Borrower?', 'Property Address', 'City', 'ST', 'Zip Code', 'Smoker', 'Heart Attack', 'Stroke', 'Cancer', 'Diabetes']);
    expect(m).toMatchObject({
      full_name: 'Lead Name', phone: 'Phone #', lender: 'Lender', loan_amount: 'Loan Amt', age: 'Age', coborrower: 'Co-Borrower?',
      address: 'Property Address', city: 'City', state: 'ST', zip: 'Zip Code', tobacco: 'Smoker', health_heart: 'Heart Attack',
      health_stroke: 'Stroke', health_cancer: 'Cancer', health_diabetes: 'Diabetes',
    });
  });
  it('prefers first/last over a combined name', () => {
    expect(suggestMapping(['Name', 'First Name', 'Last Name', 'Phone'])).toEqual({ first_name: 'First Name', last_name: 'Last Name', phone: 'Phone' });
  });
  it('requires phone and a name', () => {
    expect(validateMapping({}, ['A'])).toHaveLength(2);
    expect(validateMapping({ phone: 'Missing', full_name: 'A' }, ['A'])[0]).toMatch(/not in the sheet/);
  });
});
