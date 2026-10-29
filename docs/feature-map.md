# Feature map (2026-10-29)

How the recent features flow through data, server and UI, and where the same idea is defined more than once. Written before the consolidation PRs (#45–#48); the duplicates listed here are what they removed. Where each idea lives now: outcomes `src/shared/outcomes.ts`, statuses and Leads tabs `src/shared/leadStatus.ts`, appointment results `APPT_RESULTS` in `src/shared/appointments.ts`, funnel steps `src/shared/funnel.ts`, SQL pieces `src/server/db/sql.ts`. Line references are to `main` at `86d1100`.

## How each feature flows

| Feature | Data (tables, migrations) | Server | UI |
|---|---|---|---|
| Several phone numbers per lead | `lead.phone_e164` + `lead_other_phone` (018), view `lead_number` | `domain/leadPhones.ts` reads and writes; `leadState.ts` picks the active number and rules out bad or dead-pile numbers shared with other leads | `shared/phones.ts` (`OtherPhone`), `LeadDetails`, `EditLead`, dial-alt key on the Calling screen |
| AI import review | `import_draft*` tables | `domain/drafts.ts` (`DraftWorker`), `ai/readers.ts` | `ImportPage.tsx`, `ReviewWindow.tsx`, `shared/drafts.ts` |
| Bulk caller ID change on calls | `call.from_number_id`, `audit_log` | `calls.ts` `changeCallerId`, `POST /api/calls/caller-id` | `CallsPage.tsx` |
| Updates in Settings | — | `server/updates.ts`, `desktop/updater.ts`, `scripts/mpcrm-update.mjs` | `UpdateBar.tsx` (also rendered in Settings) |
| "MPCRM - [Last name]" window title | — | — | `CallingPage.tsx` effect on the open lead |
| First call / Appointment switch | `outcome_code.kind` (021) | outcomes come with their `kind` from `/api/meta` | `CallingPage.tsx` `defaultMode`, `LogCall.tsx`, `shortcuts.ts` (keys per side), `switch_mode` action |
| Appointment outcomes | rows `appt_*` in `outcome_code` (021) | `shared/appointments.ts` `APPT_OUTCOME_RESULT`; `leadState.ts` `deriveLeadState`; `unitrustAppointments.ts` `appointmentsOnDays` | `LogCall.tsx`, `ApptBadge` |
| Lead status tags and Leads tabs | `lead_state.status`, `appt_result`, `appt_missed` | `callList.ts` `leadFilterWhere`, `APPT_TABS`; `leadRoutes.ts` status enum | `LeadsPage.tsx` `STATUSES`, `LeadDetails.tsx` `STATUS_LABEL`, `StatusBadge`, `ApptBadge` |
| Extended funnel | calls + outcomes + appointments | `reports.ts` `todayStats` (first calls only) + `appointmentCounts` | `Funnel.tsx` `STEPS`, top bar `TodayStats` in `App.tsx` |
| Objections per call | `objection_code`, `call_objection` (021) | `domain/objections.ts`, accepted on `POST /api/calls`, listed in `/api/meta` | chips in `LogCall.tsx` after outcomes with `objections` in the registry |
| Unitrust calendar sync | `appointment`, `appointment_result` (019, 020) | `unitrustRoutes.ts`, `unitrustAppointments.ts` (color → result, reschedules) | `extension/unitrust/`, Settings card, Reports appointments, top bar |

## The same idea defined more than once

### Call outcomes

The `outcome_code` table holds label, group, hotkey, kind, pickup, callback and dead-pile flags. On top of it, code repeats facts about specific codes:

| Fact | Where it is written |
|---|---|
| Which outcomes mean "booked" | `leadState.ts` `BOOKED_CODES` (`appointment`, `sat_no_sale`, `sold`) |
| Which outcome counts as "appointment set" | `reports.ts` `CALL_METRICS.appointments` and `todayStats` (`= 'appointment'`), `numbers.ts` `numberStats` (`= 'appointment'`) |
| Callback | `reports.ts` (twice), `leadState.ts`, `LeadDetails.tsx` (`=== 'callback'`) |
| Appointment outcome → result | `shared/appointments.ts` `APPT_OUTCOME_RESULT` |
| Saves without Enter | `LogCall.tsx` `instantOutcome` (no callback time, not a pickup) |
| Spreadsheet status words → outcome | `sheetHistory.ts` (plain strings, no type check) |
| `lead_effect` column | loaded into `LeadFacts` and never read |
| Every outcome's row | migrations 002, 005, 008, 016, 021 each insert or update rows |

Adding an outcome today means a migration plus edits in up to five files.

### Lead status

| Fact | Where |
|---|---|
| The statuses | `leadState.ts` `LeadStatus` type |
| Their labels | `LeadDetails.tsx` `STATUS_LABEL` |
| Which can be called (`new`, `retry`, `callback`) | `callList.ts` `CALLABLE`, `LeadsPage.tsx` `CALLABLE`, `LeadViewer.tsx`, `CallingPage.tsx` (auto-dial), `reports.ts` (`left`), and in SQL in `importHistory.ts` and `areaCodes.ts` |
| Statuses that don't change with time | `leadState.ts` `verifyLeadState` |
| Leads page tabs | `LeadsPage.tsx` `STATUSES`, `leadRoutes.ts` zod enum, `callList.ts` `leadFilterWhere` and `APPT_TABS` |

### Appointment results

| Fact | Where |
|---|---|
| The results and labels | `shared/appointments.ts` `ApptResult`, `APPT_RESULT_LABEL` |
| Which put the lead back on the list | `shared/appointments.ts` `MISSED_RESULTS` |
| Unitrust color → result | `unitrustAppointments.ts` (green sold, red no-show, yellow sat or rescheduled, blue booked) |
| Which stored results count | `leadState.ts` `latestUnitrustAppt` and `unitrustAppointments.ts` `appointmentsOnDays`, each with its own list |
| A second name for the same thing | `ApptOutcome` (`pending`) next to `ApptResult` (`not_set`), mapped back in `ReportsPage.tsx` `OUTCOME_BADGE` |
| Sat / prezi / sale roll-up | `unitrustAppointments.ts` `appointmentCounts` |

### Funnel and top bar

- Step names and order: `Funnel.tsx` `STEPS`, the top bar in `App.tsx`, Reports headings. Each writes its own labels.
- "First calls only": `reports.ts` `loadCalls` and `todayStats` filter on `kind`; `numbers.ts` `numberStats` does not, so the Numbers page counts appointment calls as calls and pickups (pinned in `test/integration/outcomeEffects.test.ts`).

### Call type (mode)

- `CallMode` in `shared/appointments.ts`, `outcome_code.kind` in SQL, `o.kind ?? 'first_call'` in `shortcuts.ts`, and literal `'first_call' | 'appointment'` arrays in `CallingPage.tsx` and `shortcuts.ts`.
- Which side opens first (`defaultMode`) is a business rule living in `CallingPage.tsx`.

### SQL fragments

- The current-outcome condition (`NOT EXISTS (… supersedes_id = o.id)`) is written 12 times in 8 domain files.
- The lead-name expression is written 11 times.

## Inconsistencies found (kept as they are, for a decision)

1. **Legacy "booked" codes.** `sat_no_sale` and `sold` (retired first-call outcomes, still on older calls) make a lead "Appointment set", but Reports, the top bar and the Numbers page don't count them as appointments set.
2. **The Numbers page counts appointment calls** as calls and pickups, while the top bar and Reports count first calls only.

`test/integration/outcomeEffects.test.ts` pins both, so any change to them will be a deliberate one.
