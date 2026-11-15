import { describe, it, expect } from 'vitest';
import { fillText, niceName, placeholdersIn, STARTER_TEXTS, TextTemplates } from '../../src/shared/texts.js';

describe('text templates', () => {
  it('fills in [[field]] in any case and with spaces, and lists the ones the lead has nothing for', () => {
    expect(fillText('Hi [[first_name]], about [[ Lender ]] in [[city]].', { first_name: 'Jane', lender: 'Chase', city: '' }))
      .toEqual({ text: 'Hi Jane, about Chase in.', missing: ['city'] });
    expect(fillText('Hi [[first_name]], it\'s [[my_name]].', { my_name: 'Al' })).toEqual({ text: 'Hi, it\'s Al.', missing: ['first_name'] });
    expect(fillText('Spouse: [[Spouse name]]', { 'spouse name': 'Bo' }).text).toBe('Spouse: Bo');
  });

  it('finds each placeholder once', () => {
    expect(placeholdersIn('[[a]] [[b]] [[A]] [[ c ]] [not] [[]]')).toEqual(['a', 'b', 'c']);
  });

  it('only fixes names written in one case', () => {
    expect(niceName('JANE')).toBe('Jane');
    expect(niceName('mary-ann o\'neil')).toBe('Mary-Ann O\'Neil');
    expect(niceName('McDonald')).toBe('McDonald');
    expect(niceName(null)).toBe('');
  });

  it('the starter texts are valid, and two with one name are refused', () => {
    expect(TextTemplates.parse(STARTER_TEXTS)).toHaveLength(4);
    expect(TextTemplates.safeParse([{ id: 'a', name: 'X', body: '' }, { id: 'b', name: 'x', body: '' }]).success).toBe(false);
  });
});
