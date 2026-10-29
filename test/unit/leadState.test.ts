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

  it('Unitrust: a newer no-show brings a booked lead back now; an older one or the dead pile does not', () => {
    const booked = { ...empty, calls: [call('c1', '2026-10-17T10:00:00.000Z')], outcomes: [out('c1', 'appointment', '2026-10-17T10:01:00.000Z', { grp: 'contact', counts_as_human_contact: 1 })] };
    expect(deriveLeadState({ ...booked, appt: { result: 'no_show', at: '2026-10-17T12:00:00.000Z' } }, NOW)).toMatchObject({ status: 'retry', next_due_at: null, appt_missed: 1, appt_result: 'no_show' });
    expect(deriveLeadState({ ...booked, appt: { result: 'no_show', at: '2026-10-17T09:00:00.000Z' } }, NOW)).toMatchObject({ status: 'appointment_set', appt_missed: 0, appt_result: 'no_show' });
    expect(deriveLeadState({ ...booked, appt: { result: 'sold', at: '2026-10-17T12:00:00.000Z' } }, NOW)).toMatchObject({ status: 'appointment_set' });
    const dead = { ...booked, actions: [{ action: 'mark_dead' as const, created_at: '2026-10-17T11:00:00.000Z' }] };
    expect(deriveLeadState({ ...dead, appt: { result: 'no_show', at: '2026-10-17T12:00:00.000Z' } }, NOW).status).toBe('dead');
  });
  describe('appointment calls logged here', () => {
    const contact = { grp: 'contact', counts_as_human_contact: 1 };
    const booked = { ...empty, calls: [call('c1', '2026-10-16T10:00:00.000Z')], outcomes: [out('c1', 'appointment', '2026-10-16T10:01:00.000Z', contact)] };
    const appt = (code: string, at = '2026-10-17T13:00:00.000Z', extra = contact): LeadFacts => ({
      ...booked, calls: [...booked.calls, call('c2', at)], outcomes: [...booked.outcomes, out('c2', code, at, extra)],
    });

    it('no show, sat no sale and prezi come back to be called now, each with its own tag', () => {
      expect(deriveLeadState(appt('appt_no_show', undefined, { grp: 'no_contact', counts_as_human_contact: 0 }), NOW))
        .toMatchObject({ status: 'retry', next_due_at: null, appt_missed: 1, appt_result: 'no_show' });
      expect(deriveLeadState(appt('appt_sat_no_sale'), NOW)).toMatchObject({ status: 'retry', appt_missed: 1, appt_result: 'sat_no_sale' });
      expect(deriveLeadState(appt('appt_prezi'), NOW)).toMatchObject({ status: 'retry', appt_missed: 1, appt_result: 'prezi' });
    });

    it('a sale or a reschedule stays out of the queue', () => {
      expect(deriveLeadState(appt('appt_sale'), NOW)).toMatchObject({ status: 'appointment_set', appt_result: 'sold', appt_missed: 0 });
      expect(deriveLeadState(appt('appt_rescheduled'), NOW)).toMatchObject({ status: 'appointment_set', appt_result: 'rescheduled' });
    });

    it('beats a later Unitrust color for the same appointment (Unitrust has no color for a prezi)', () => {
      const s = deriveLeadState({ ...appt('appt_prezi'), appt: { result: 'sat_no_sale', at: '2026-10-17T14:00:00.000Z', day: '2026-10-17' } }, NOW);
      expect(s).toMatchObject({ status: 'retry', appt_result: 'prezi', appt_missed: 1 });
      const sold = deriveLeadState({ ...appt('appt_sale'), appt: { result: 'sat_no_sale', at: '2026-10-17T14:00:00.000Z', day: '2026-10-17' } }, NOW);
      expect(sold).toMatchObject({ status: 'appointment_set', appt_result: 'sold' });
    });

    it('a newer Unitrust appointment (they booked again) counts again', () => {
      const s = deriveLeadState({ ...appt('appt_prezi'), appt: { result: 'not_set', at: '2026-10-17T14:00:00.000Z', day: '2026-10-20' } }, NOW);
      expect(s).toMatchObject({ status: 'appointment_set', appt_result: 'not_set', appt_missed: 0 });
    });

    it('booked again on a first call after a prezi: booked, and the old result no longer shows', () => {
      const f = appt('appt_prezi');
      const again = { ...f, calls: [...f.calls, call('c3', '2026-10-17T14:00:00.000Z')], outcomes: [...f.outcomes, out('c3', 'appointment', '2026-10-17T14:00:00.000Z', contact)] };
      expect(deriveLeadState(again, NOW)).toMatchObject({ status: 'appointment_set', appt_result: 'not_set', appt_missed: 0 });
    });

    it('a first call after a no-show starts the usual retry and keeps the tag', () => {
      const f = appt('appt_no_show', undefined, { grp: 'no_contact', counts_as_human_contact: 0 });
      const later = { ...f, calls: [...f.calls, call('c3', '2026-10-17T14:00:00.000Z')], outcomes: [...f.outcomes, out('c3', 'no_answer', '2026-10-17T14:00:00.000Z')] };
      expect(deriveLeadState(later, NOW)).toMatchObject({ status: 'retry', appt_missed: 0, appt_result: 'no_show' });
    });
  });
});
