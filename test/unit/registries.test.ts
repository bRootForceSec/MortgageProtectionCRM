import { describe, it, expect } from 'vitest';
import { APPT_RESULT_LABEL, MISSED_RESULTS, openingSide, resultOfColor } from '../../src/shared/appointments.js';
import { CALLABLE_STATUSES, LEAD_FILTERS, LEAD_STATUSES, LEAD_TABS, isCallable, statusLabel } from '../../src/shared/leadStatus.js';
import { FUNNEL_STEPS, funnelStepsOf } from '../../src/shared/funnel.js';
import { OUTCOMES } from '../../src/shared/outcomes.js';

// The shared registries give the same lists, labels and rules that were written out by hand before.

describe('lead statuses and Leads tabs', () => {
  it('callable statuses', () => {
    expect(CALLABLE_STATUSES).toEqual(['new', 'retry', 'callback']);
    expect(['new', 'retry', 'callback', 'appointment_set', 'invalid', 'dead', 'toString', '', null].map(isCallable))
      .toEqual([true, true, true, false, false, false, false, false, false]);
  });

  it('labels', () => {
    expect(Object.fromEntries(Object.entries(LEAD_STATUSES).map(([k, v]) => [k, v.label]))).toEqual({
      new: 'New', retry: 'Tried', callback: 'Callback', appointment_set: 'Appointment set', invalid: 'Bad number', dead: 'Dead lead',
    });
    expect(statusLabel('something_else')).toBe('something_else');
  });

  it('only a retry changes with time', () => {
    expect(Object.entries(LEAD_STATUSES).filter(([, d]) => !d.timeless).map(([k]) => k)).toEqual(['retry']);
  });

  it('the tabs, in order', () => {
    expect(LEAD_TABS.map((t) => `${t.key}:${t.label}`)).toEqual([
      'all:All', 'new:Never called', 'no_answer:No answer', 'talked:Talked, no appt', 'callback:Callbacks', 'appointment_set:Appointment set',
      'appt_no_show:No-shows', 'appt_sat_no_sale:Sat, no sale', 'appt_prezi:Prezis', 'appt_sold:Sold', 'invalid:Bad numbers', 'dead:Dead pile',
    ]);
  });

  it('the filters the Leads API accepts', () => {
    expect([...LEAD_FILTERS].sort()).toEqual(
      ['dead', 'invalid', 'appointment_set', 'appt_missed', 'appt_no_show', 'appt_sat_no_sale', 'appt_prezi', 'appt_sold', 'callback', 'retry', 'no_answer', 'talked', 'new', 'all'].sort(),
    );
  });
});

describe('appointment results', () => {
  it('labels and which put the lead back', () => {
    expect(APPT_RESULT_LABEL).toEqual({
      not_set: 'Appt booked', rescheduled: 'Rescheduled', sold: 'Sold', no_show: 'No-show', sat_no_sale: 'Sat, no sale', prezi: 'Prezi, no sale',
    });
    expect(MISSED_RESULTS).toEqual(['no_show', 'sat_no_sale', 'prezi']);
  });

  it('Unitrust colors', () => {
    expect((['blue', 'green', 'red', 'yellow'] as const).map(resultOfColor)).toEqual(['not_set', 'sold', 'no_show', null]);
  });

  it('which side of the Calling screen a lead opens on', () => {
    expect(openingSide(null)).toBe('first_call');
    expect(openingSide({ status: 'appointment_set', appt_result: null })).toBe('appointment');
    expect(openingSide({ status: 'appointment_set', appt_result: 'not_set' })).toBe('appointment');
    expect(openingSide({ status: 'appointment_set', appt_result: 'rescheduled' })).toBe('appointment');
    expect(openingSide({ status: 'appointment_set', appt_result: 'sold' })).toBe('first_call');
    expect(openingSide({ status: 'retry', appt_result: 'no_show' })).toBe('first_call');
  });
});

describe('the funnel', () => {
  it('steps, top to bottom', () => {
    expect(FUNNEL_STEPS.map((s) => s.label)).toEqual(['Dials', 'Leads called', 'Pickups', 'Appts set', 'Sat', 'Prezis', 'Sales']);
  });

  it('which steps one call with each outcome reaches', () => {
    const active = Object.entries(OUTCOMES).filter(([, o]) => o.active).map(([c]) => [c, funnelStepsOf(c)]);
    expect(Object.fromEntries(active)).toEqual({
      no_answer: [], no_appt: ['pickups'], appointment: ['pickups', 'appts_set'], bad_number: [], callback: ['pickups'],
      appt_no_show: [], appt_sat_no_sale: ['sat'], appt_prezi: ['sat', 'prezis'], appt_sale: ['sat', 'prezis', 'sales'], appt_rescheduled: [],
    });
    expect(funnelStepsOf('nope')).toEqual([]);
  });
});

describe('objections', () => {
  it('are asked after a talk with no appointment, a sat no sale and a prezi', () => {
    expect(Object.entries(OUTCOMES).filter(([, o]) => o.objections).map(([c]) => c)).toEqual(['no_appt', 'appt_sat_no_sale', 'appt_prezi']);
  });
});
