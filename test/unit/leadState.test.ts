import { describe, it, expect } from 'vitest';
import { deriveLeadState, type LeadFacts } from '../../src/server/domain/leadState.js';

const empty: LeadFacts = { calls: [], outcomes: [], actions: [] };
const NOW = '2026-10-17T15:00:00.000Z';
const call = (id: string, at: string, from: string | null = 'n1') => ({ id, requested_at: at, from_number_id: from, initiation_result: 'accepted' });
const out = (call_id: string, code: string, at: string, extra: Partial<LeadFacts['outcomes'][number]> = {}) => ({
  call_id, entered_at: at, outcome_code: code, grp: 'no_contact', marks_dead: 0, counts_as_human_contact: 0, callback_due_at: null, ...extra,
});

describe('deriveLeadState', () => {
  it('new lead', () => expect(deriveLeadState(empty, NOW)).toMatchObject({ status: 'new', attempts_total: 0 }));

  it('retry after an attempt, due 4 hours later', () => {
    const s = deriveLeadState({ ...empty, calls: [call('c1', '2026-10-17T10:00:00.000Z')], outcomes: [out('c1', 'no_answer', '2026-10-17T10:01:00.000Z')] }, NOW);
    expect(s).toMatchObject({ status: 'retry', attempts_total: 1, next_due_at: '2026-10-17T14:00:00.000Z', last_outcome_code: 'no_answer' });
  });

  it('do-not-call outcome sends the lead to the dead pile', () => {
    const s = deriveLeadState({
      ...empty,
      calls: [call('c1', '2026-10-17T10:00:00.000Z')],
      outcomes: [out('c1', 'dnc_request', '2026-10-17T10:01:00.000Z', { grp: 'dead', marks_dead: 1, counts_as_human_contact: 1 })],
    }, NOW);
    expect(s.status).toBe('dead');
  });

  it('the Do not call tick sends the lead to the dead pile, whatever the outcome', () => {
    const s = deriveLeadState({
      ...empty,
      calls: [call('c1', '2026-10-17T10:00:00.000Z')],
      outcomes: [out('c1', 'no_appt', '2026-10-17T10:01:00.000Z', { grp: 'contact', counts_as_human_contact: 1, do_not_call: 1 })],
    }, NOW);
    expect(s).toMatchObject({ status: 'dead', preferred_number_id: 'n1' });
  });

  it('restore after dead brings the lead back', () => {
    const s = deriveLeadState({
      ...empty,
      calls: [call('c1', '2026-10-17T10:00:00.000Z')],
      outcomes: [out('c1', 'dnc_request', '2026-10-17T10:01:00.000Z', { grp: 'dead', marks_dead: 1 })],
      actions: [{ action: 'restore', created_at: '2026-10-17T11:00:00.000Z' }],
    }, NOW);
    expect(s.status).toBe('retry');
  });

  it('callback uses the due time', () => {
    const s = deriveLeadState({
      ...empty,
      calls: [call('c1', '2026-10-17T10:00:00.000Z')],
      outcomes: [out('c1', 'callback', '2026-10-17T10:01:00.000Z', { grp: 'contact', counts_as_human_contact: 1, callback_due_at: '2026-10-18T22:00:00.000Z' })],
    }, NOW);
    expect(s).toMatchObject({ status: 'callback', next_due_at: '2026-10-18T22:00:00.000Z' });
  });

  it('appointment set takes the lead out of the queue, with no date, and its number is preferred', () => {
    const booked = deriveLeadState({
      ...empty,
      calls: [call('c1', '2026-10-17T10:00:00.000Z', 'nA'), call('c2', '2026-10-17T12:00:00.000Z', 'nB')],
      outcomes: [
        out('c1', 'vm_left', '2026-10-17T10:05:00.000Z'),
        out('c2', 'appointment', '2026-10-17T12:01:00.000Z', { grp: 'contact', counts_as_human_contact: 1 }),
      ],
    }, NOW);
    expect(booked).toMatchObject({ status: 'appointment_set', next_due_at: null, preferred_number_id: 'nB', attempts_total: 2 });
    // Older history may say sat or sold: that still means booked.
    const sold = deriveLeadState({ ...empty, calls: [call('c1', '2026-10-17T10:00:00.000Z', 'nA')], outcomes: [out('c1', 'sold', '2026-10-17T10:05:00.000Z')] }, NOW);
    expect(sold).toMatchObject({ status: 'appointment_set', preferred_number_id: 'nA' });
    // A later call decides again.
    const later = deriveLeadState({
      ...empty,
      calls: [call('c1', '2026-10-17T10:00:00.000Z', 'nA'), call('c2', '2026-10-17T12:00:00.000Z', 'nB')],
      outcomes: [out('c1', 'appointment', '2026-10-17T10:05:00.000Z'), out('c2', 'callback', '2026-10-17T12:01:00.000Z', { callback_due_at: '2026-10-18T15:00:00.000Z' })],
    }, NOW);
    expect(later).toMatchObject({ status: 'callback', preferred_number_id: 'nA' });
  });

  it('is independent of input order', () => {
    const f: LeadFacts = {
      ...empty,
      calls: [call('c2', '2026-10-17T12:00:00.000Z'), call('c1', '2026-10-17T10:00:00.000Z')],
      outcomes: [out('c2', 'vm_left', '2026-10-17T12:01:00.000Z'), out('c1', 'no_answer', '2026-10-17T10:01:00.000Z')],
    };
    const g: LeadFacts = { ...f, calls: [...f.calls].reverse(), outcomes: [...f.outcomes].reverse() };
    expect(deriveLeadState(f, NOW)).toEqual(deriveLeadState(g, NOW));
    expect(deriveLeadState(f, NOW).last_outcome_code).toBe('vm_left');
  });

  it('blocked attempts are not counted', () => {
    const s = deriveLeadState({ ...empty, calls: [{ ...call('c1', '2026-10-17T10:00:00.000Z'), initiation_result: 'blocked_hours' }] }, NOW);
    expect(s).toMatchObject({ status: 'new', attempts_total: 0 });
  });
});
