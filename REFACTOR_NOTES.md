# Refactor notes

A running log of the stabilization work. Newest first.

## 2026-10-21: X3 dropped, X4 docs

- **X3 dropped** (Linux service, kept as decided in D1). Every place reads `MPCRM_PORT`; the default 5170 repeats only in scripts that can't share code with the app. The token in `xdg-open`'s arguments ends up in the browser's arguments too, so moving it would need a different way of opening the app. No change.
- **X4:** `docs/phase-0-plan.md` is marked historical. New `env.example` lists every environment variable and where to set it. The README's Development section now covers how to run, check, configure, the code layout and the conventions (pointing to `CLAUDE.md`).
- **README fixes:** the keys table said outcomes were `1`–`5` with `4` as Bad number and callbacks on `5`; the app has six (Do not call is `4`, Bad number `5`, Callback `6`), and `1` and `5` save straight away. Added the `L` and `B` keys. Added a "what is and isn't encrypted" note for all systems (D9); it was only in the Fedora section.

## 2026-10-21: C5 web tidy-ups

- **Storage** (`src/web/storage.ts`): `getStored`, `setStored`, `getStoredJson`, `setStoredJson`. They replace seven hand-written `localStorage` wrappers in CallingPage, ImportPage, UpdateBar, GroupPicker, CallbackAlerts, LeadsPage, ReportsPage and App. Blocked storage still just loses the preference. A new structure rule keeps `localStorage` inside `storage.ts`.
- **Day helpers** (`src/web/when.ts`): `startOfDay`, `addDays`, `dayRange`, `todayRange` and `ymd` replace page-local copies in CallsPage, LeadsPage, ReportsPage, NumbersPage, TodayPage, App and CallbackAlerts. Each page gets the same values as before. Tests in `test/unit/when.test.ts`.
- **Open question, not changed:** "today" and the Calls page's day are 24 hours from midnight (`dayRange`), while Reports counts calendar days. On the two days a year the clocks change, the 24-hour version is an hour short or long. I kept it as it was; it only matters for calls made in the last hour of those days.
- **Upload:** `api.upload` takes extra headers, and BulkImport sends through it. It keeps its single retry on a dropped connection. The only visible difference: when the app answers with an error that isn't JSON, the message now reads "Request failed (500)" like everywhere else, instead of "the app answered 500".
- **CallingPage split:** the log-call form (with its timer and the restore box) moved to `pages/LogCall.tsx`. CallingPage went from about 1,050 to 730 lines. Pure move.
- **Renames:** `LeadPage` → `SourcePage` (the page the lead came from) and `LeadView` → `LeadDetails` (summary, call history, notes). `LeadViewer` keeps its name.
- Checks: typecheck, lint, 220 tests, build, and 10 e2e tests pass.

## 2026-10-21: C4 shared types

- New `src/shared/`, imported by both the server and the UI (decided D5):
  - `callingSettings.ts`: the zod schema for Calling settings and the shortcut action list. The UI's hand-copied `CallingSettings` and `ShortcutAction` types are gone; it now uses the type made from the server's schema, so they can't drift.
  - `drafts.ts`: the draft review states and progress shape, used by `drafts.ts`, `bulkImport.ts` and the import screens.
  - `age.ts`: `ageOn`. The UI's `personAge` had its own copy of the same arithmetic.
- `tsconfig.server.json` now compiles from `src/` into `dist/`, so `src/shared` builds to `dist/shared`. `dist/server/` is laid out exactly as before, so `npm start`, the Linux service, the updater and the desktop app find their files in the same places. I built and started it to check.
- Not moved yet: lead detail, draft view and the other response shapes in `web/api.ts` and `web/importTypes.ts`. The server builds those from untyped queries, so sharing them first needs typed domain functions. `fmtPhone` (audit 2.7) no longer has a server copy since X1 deleted `formatUsPhone`.
- A new structure rule keeps `node:` imports and server or web code out of `src/shared`.
- Checks: typecheck, lint, 217 tests, build, and 10 e2e tests pass.

## 2026-10-21: C2 logging and config

- `MPCRM_APP_DIR` is read once, in `loadConfig` (`config.appDir`). `server.ts` and `main.ts` each read it themselves before. `main.ts` no longer passes a runtime, since `Updates` already works out "service" or "manual" from the same folder. Test: `test/unit/config.test.ts`.
- The page checker's warnings go to the server log instead of `console.warn`.
- The `console.*` left in the server: `cli.ts` (prints on purpose), `config.ts` and `main.ts` (before the logger exists), and `updates.ts` (a desktop install failing after the server stopped). The structure check allows only these.
- The desktop app's own env reads (`MPCRM_UPDATE_FEED`, `APPIMAGE`, autostart paths) stay in `src/desktop`; that's a separate process.
- Checks: typecheck, lint, 217 tests, build, and 10 e2e tests pass.

## 2026-10-21: C1, C3, X1, X2 structure and cleanup

- **C1** shared pieces in `src/server/core/`: `errors.ts` (`DomainError`), `settings.ts` (`getSetting`/`setSetting`, moved out of `ai/settings.ts`) and `audit.ts` (`audit()`, which replaces three hand-written `INSERT INTO audit_log`). User mistakes that threw a plain `Error` now throw `DomainError`, so they give a 4xx instead of a 500: setting "called back" on a missing lead (404), an unknown shortcut action and an unknown report number. Two routes that caught and rewrapped errors no longer do. `tableNames(db)` in `db/connection.ts` is shared by backups and the full export. The structure check now refuses `INSERT INTO audit_log` outside `core/audit.ts`.
- **X2** (decided D2): deleted `/api/queue`, `/api/imports/preview`, `/api/imports/commit` and `domain/queue.ts`. Nothing in the app called them. Tests that used the queue now read `lead_state` through a `dueLeads` test helper, and the upload test goes through the draft flow the app uses.
- **X1:** deleted dead exports: `pdfPageCount`, `formatUsPhone`, `COUNTY_TIME_ZONES`, `mapRow`, `analyzeSheet`, `FIELD_LABELS` and the web `toLocalInput`.
- **C3:** every query in the route files moved into domain functions (new `domain/leads.ts`, `domain/importHistory.ts`, `domain/leadTypes.ts`, plus additions to numbers, calls, reports, leadEdit, areaCodes, callList and backup). The structure check now allows no SQL in any route file. `app.ts` went from about 700 lines to 136 and only wires the route files together: `leadRoutes`, `numberRoutes`, `dataRoutes` are new, uploads moved into `importRoutes`, and today's stats into `reportRoutes`. No route changed its path, input or output.
- Checks: typecheck, lint, 216 tests (2 queue-only tests removed, 1 caller ID test added), build, and 10 e2e tests pass.

## 2026-10-21: R3, R4, R5 reliability

- **R3, UI errors** (user-visible): failed loads the user depends on now show an error toast. That covers counties in the group picker, lead types, and calling settings at start. A failed KDE Connect device lookup shows in its card. Restoring a dead lead from the Calling screen now shows an error if it fails. Background polls (update status, today's stats, page check, backup check, number stats) and PDF cleanup keep a quiet catch, each with a comment saying why. The structure check now allows no silent catch in the UI.
- **R4, Claude Code reader** (`ai/readers.ts` `run`): a run that ignores the stop signal is forced to stop 5 s later. Output over 10 MB stops the run, and stderr keeps only its last 10 MB. Test: `test/unit/readerRun.test.ts`, which failed without the fix.
- **R5:** `desktop.json` is written to a temp file and renamed into place. The restore's "is the app running" check treats EPERM as running, like the server's check. **Dropped:** refusing to open a database newer than the app. Migration 006 was removed after shipping, so real databases may record it, and the desktop app rolls back failed updates; refusing would stop the app opening in both cases.
- **R7** (user-visible, decided D3): `/api/stats/today` leaves out spreadsheet-history calls (`time_known = 0`), matching Reports. Test: `refinements.test.ts`.
- Checks: typecheck, lint, 217 tests, build, and 10 e2e tests pass.

## 2026-10-21: T2, T3, R1, R2 tests and reliability

- **T2** `test/integration/routes.test.ts`: 16 characterization tests for 27 routes that had no HTTP test. They cover lead notes, actions, called-back, outcome changes, lead links, call-list skip, clear-worked and saved-list delete, import history, problems.csv, the spreadsheet draft flow end to end, lead types, county area codes, the page checker, the AI test and backups.
- **T3 + R1** (`server.ts`, `drafts.ts`, `bulkImport.ts`): `DraftWorker` and `BulkImporter` have `stop()`, and `server.stop()` calls both before closing the database. Before, a PDF being read during quit or an update restart hit the closed database and ended in an unhandled rejection; I reproduced that first. An interrupted draft stays "reading" and resumes on the next start, as before. Test: `test/integration/shutdown.test.ts`.
- **R2** (`drafts.ts` `commitDraft`): importing the rows, copying the file and marking the draft committed now happen in one transaction. A failed copy no longer leaves imported leads behind a draft that still looks open, so trying again can't import twice. Test: `pdfImport.test.ts`, "a failed commit imports nothing".
- Checks: typecheck, lint, 213 tests, build, and 10 e2e tests pass.

## 2026-10-21: T1 lint and structure checks

- `npm run lint` = `oxlint` (`.oxlintrc.json`) + `scripts/check-structure.mjs`. It runs in CI after typecheck.
- **oxlint, not ESLint:** typescript-eslint doesn't support TypeScript 7 (it needs TypeScript < 6.1). oxlint is a single dev dependency, pinned to 1.86.0, and reads the existing `eslint-disable-line react-hooks/exhaustive-deps` comments. Its React Compiler rules are off because this app doesn't use the compiler.
- **Structure check:** a per-file allowance at today's counts for SQL in route files, silent `.catch(() => {})` in the UI and `console.*` in the server. The counts can only go down.
- **Code fixed for the linter (no behavior change):** CallingPage `items` memoized and `calledBack` made a declared-before-use `useCallback`; ImportPage ternary statements became if/else; an unused import and helper removed.
- Added `.github/pull_request_template.md` with a short "fits the existing structure" checklist.
- Checks: typecheck, lint, 195 unit/integration tests, build, and all 10 e2e tests pass.

## 2026-10-21: CLAUDE.md conventions

- Added `CLAUDE.md`: where new code goes, which shared pieces to reuse, data rules, and the pre-push checks. Every Claude session reads it, so new features build on the shared pieces instead of copying them. Update it whenever a plan step moves a shared piece.

## 2026-10-21: Safety steps S1–S4

- **S1 `MPCRM_BACKUP_KEEP`** (`src/server/config.ts`): values below 1 now mean 1, and a value that isn't a whole number falls back to 30, with a warning in both cases. Before, 0 deleted every backup and a non-number stopped pruning. Test: `test/unit/config.test.ts`.
- **S2 upload file names** (`src/server/http/importRoutes.ts` `uploadHeader`, used by `app.ts` too): a badly encoded `x-file-name` falls back to the default name instead of returning 500. Test: `test/integration/http.test.ts`.
- **S3 dropped:** the XLSX export already stores values as text, so there was no formula risk to fix.
- **S4:** `@types/qrcode` moved to devDependencies; CI actions pinned to commit SHAs.

## 2026-10-21: Phase 1 audit and Phase 2 plan

- Added `AUDIT.md` (findings) and `PLAN.md` (target architecture, ordered steps and open decisions).
- No application code changed.
- No committed secrets found in git history; nothing needs rotating.
- Waiting for approval of the plan before any refactoring step.
