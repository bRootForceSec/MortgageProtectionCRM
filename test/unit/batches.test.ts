import { describe, it, expect } from 'vitest';
import { batchMatches, groupByImport } from '../../src/shared/batches.js';

describe('batch filter', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const b = { name: 'Allen County Oct', file_name: 'IN_260_1-30.pdf', imported_at: '2026-10-20T12:00:00Z', lead_types: ['D', ''], left: 2 };
  it('matches every word of the search, in the name, file name or lead types', () => {
    expect(batchMatches(b, {}, now)).toBe(true);
    expect(batchMatches(b, { search: 'allen oct' }, now)).toBe(true);
    expect(batchMatches(b, { search: 'IN_260' }, now)).toBe(true);
    expect(batchMatches(b, { search: 'allen marion' }, now)).toBe(false);
  });
  it('filters by how recent, lead type and leads left', () => {
    expect(batchMatches(b, { days: 5 }, now)).toBe(false);
    expect(batchMatches(b, { days: 30 }, now)).toBe(true);
    expect(batchMatches(b, { lead_type: 'D' }, now)).toBe(true);
    expect(batchMatches(b, { lead_type: '' }, now)).toBe(true);
    expect(batchMatches(b, { lead_type: 'C' }, now)).toBe(false);
    expect(batchMatches({ ...b, left: 0 }, { left: true }, now)).toBe(false);
  });
});

describe('groupByImport', () => {
  it('keeps the order, putting each bulk import\'s files together at its first one', () => {
    const rows = [{ id: 1, bulk_id: 'x' }, { id: 2, bulk_id: null }, { id: 3, bulk_id: 'x' }, { id: 4, bulk_id: null }];
    expect(groupByImport(rows).map((g) => g.rows.map((r) => r.id))).toEqual([[1, 3], [2], [4]]);
  });
});
