# Refactor notes

A running log of the stabilization work. Newest first.

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
