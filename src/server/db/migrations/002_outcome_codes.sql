-- Initial outcome taxonomy. Add or retire codes with new migrations; never delete a used code.
-- Per your workflow: only a do-not-call request sends a lead to the dead pile.
-- Everything else recirculates, except a disconnected/invalid number, which goes to the
-- "invalid" pile (restorable) because it cannot be dialed.
INSERT INTO outcome_code (code, label, grp, hotkey, counts_as_human_contact, requires_callback_time, marks_dead, sort_order, introduced_at) VALUES
  ('no_answer',      'No answer',                       'no_contact', '1', 0, 0, 0, 10,  '2026-10-17T00:00:00.000Z'),
  ('vm_left',        'Voicemail, message left',         'no_contact', '2', 0, 0, 0, 20,  '2026-10-17T00:00:00.000Z'),
  ('vm_no_msg',      'Voicemail, no message',           'no_contact', '3', 0, 0, 0, 30,  '2026-10-17T00:00:00.000Z'),
  ('busy',           'Busy',                            'no_contact', '4', 0, 0, 0, 40,  '2026-10-17T00:00:00.000Z'),
  ('not_interested', 'Not interested',                  'contact',    '5', 1, 0, 0, 50,  '2026-10-17T00:00:00.000Z'),
  ('callback',       'Callback requested',              'contact',    '6', 1, 1, 0, 60,  '2026-10-17T00:00:00.000Z'),
  ('appointment',    'Appointment set',                 'contact',    '7', 1, 0, 0, 70,  '2026-10-17T00:00:00.000Z'),
  ('bad_number',     'Disconnected / invalid number',   'invalid',    '8', 0, 0, 0, 80,  '2026-10-17T00:00:00.000Z'),
  ('wrong_person',   'Wrong person',                    'invalid',    '9', 1, 0, 0, 90,  '2026-10-17T00:00:00.000Z'),
  ('hung_up',        'Answered, hung up',               'contact',    'h', 1, 0, 0, 95,  '2026-10-17T00:00:00.000Z'),
  ('other',          'Other (add a note)',              'contact',    '0', 1, 0, 0, 100, '2026-10-17T00:00:00.000Z'),
  ('dnc_request',    'Do-not-call request (dead lead)', 'dead',       'd', 1, 0, 1, 110, '2026-10-17T00:00:00.000Z');
