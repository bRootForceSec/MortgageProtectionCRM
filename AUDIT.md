# Codebase audit — 2026-10-21

Phase 1 of the stabilization work. Read-only: no code was changed. Audited against `main`; no pull requests were open at the time.

Each finding has a **severity** (critical / high / medium / low) and an **effort** (S = under an hour, M = a few hours, L = a day or more). Line numbers refer to `main` as of this audit. Where a finding is an inference, not something I reproduced, it says so.

## Summary

- **No committed secrets.** I scanned all 70 commits of git history. The only hits are test fixtures (`'secret-1'`, `'access-1'` in the removed Google Calendar tests) and type names such as `SecretName`. Nothing needs rotating.
- **No critical security issues.** The local-server security model (`src/server/http/security.ts`) is sound: Host allowlist, 0600 token file, SameSite=Strict HttpOnly cookie, Origin check on writes, strict CSP, and locked-down Electron webPreferences.
- **The baseline is healthy.** Typecheck is clean, and 191 unit and integration tests pass in 21 files. CI runs typecheck, tests, build, a secret scan and e2e on three operating systems.
- **The main problems are structural.** There are three error-handling styles, four ways audit-log rows get written, three background-job patterns, SQL inside route handlers, types mirrored by hand between server and web, about seven `localStorage` wrappers and six date-range helpers. Two files hold too many jobs: `app.ts` (693 lines) and `CallingPage.tsx` (1045 lines).
- **Highest-value fixes:**
  - R1: workers are not stopped on shutdown.
  - R2: the draft commit is not atomic.
  - C1: `MPCRM_BACKUP_KEEP=0` deletes every backup.
  - T1: there is no linter, though 17 `eslint-disable` comments suggest one was intended.

## 1. Architecture and structure

| Area | Path | Notes |
|---|---|---|
| Desktop shell | `src/desktop/` | Electron main process. Starts the server in-process, manages the window, autostart and self-update. Updates come from GitHub Releases; Mac uses a custom zip swap. |
| Server | `src/server/` | Fastify 5 on 127.0.0.1:5170 with better-sqlite3 (WAL). `server.ts` wires config, the DB, workers and timers. |
| HTTP | `src/server/http/` | `app.ts` (core routes plus the error handler), `importRoutes.ts`, `callingRoutes.ts`, `reportRoutes.ts` and `security.ts`. |
| Domain | `src/server/domain/` | 22 flat modules covering calls, leads, imports (sheet, PDF, bulk), reports, numbers, counties and exports. |
| AI | `src/server/ai/` | Three reader back-ends, prompt text, settings storage and secret storage. |
| DB | `src/server/db/` | Connection and migration runner. Migrations are SQL files applied in filename order. 006 was removed on purpose after the Google Calendar revert. |
| Web | `src/web/` | React 19 + Vite. `api.ts` is the fetch client and mirrors server types. There are 11 files in `pages/` (some are not pages) and shared pieces in `components/`. |
| Scripts | `scripts/` | Linux installer and systemd self-updater, secret scan, release notes, version stamping, desktop smoke test and data generators. |
| Tests | `test/` | `unit/`, `integration/` (HTTP through Fastify inject), `e2e/` (Playwright, 3 specs) and fixtures. |

**There are two ways to ship.** The desktop app (Win/Mac/Linux AppImage) updates from GitHub Releases. The Linux systemd service (`scripts/install.sh`, `scripts/mpcrm-update.mjs`) builds from `main` on the user's machine. Every push to `main` cuts a release, so `main` is effectively production.

**Layering is mostly sound, with leaks.** Domain modules take a `db` and stay HTTP-free, which is good. The leaks:

- Route files contain raw SQL and business logic (section 2.3).
- `server.ts:17` imports `runBackupCheckIfDue` from `http/reportRoutes.ts`, so startup code depends on a route file.
- Generic settings helpers (`getSetting`/`setSetting`) live in `ai/settings.ts`, and calling, imports and others import them from there.

## 2. Duplication and fragmentation

| # | Cluster | Where | Sev | Effort |
|---|---|---|---|---|
| 2.1 | **Three error styles.** `DomainError` (with a status) lives in `domain/calls.ts` and about 10 files import it from there. `MappingError` is in `importer.ts`. Plain `Error` is thrown at `callList.ts:288`, `callingSettings.ts:84`, `reports.ts:401` and `spreadsheet.ts:44`. Routes rewrap errors by hand at `app.ts:126,134,505`, `callingRoutes.ts:28-29,59` and `reportRoutes.ts:56`. `reportRoutes.ts:74` duck-types zod errors with `e?.issues`. | server | medium | M |
| 2.2 | **Audit-log writes in four places, three styles.** A local `audit()` helper at `app.ts:687-691`, inline inserts at `importRoutes.ts:257,300` and `areaCodes.ts:62`, and domain functions in `calls.ts`. | server | medium | S |
| 2.3 | **SQL in route handlers.** `app.ts` covers the leads list (183-197), lead detail (277-335), calls history (398-423), today stats (425-444), numbers CRUD (447-494) and imports list (589-599). `importRoutes.ts:308-352` holds the lead PATCH, including business logic. | server | medium | M |
| 2.4 | **Three background-job patterns.** `DraftWorker` (`drafts.ts:274`), `BulkImporter` (`bulkImport.ts:85`) and `PageChecker` (`pageTurn.ts`/`pageTurnFix.ts`). Each has its own queue, status and error handling, and only `PageChecker` has `stop()`. | server | medium | M |
| 2.5 | **Time-zone math three times.** `normalize.ts` `zoneOffsetMinutes`, `web/when.ts`, and `reports.ts` `localParts`. Time-zone assignment also happens twice: `leadEdit.ts:48` uses `STATE_TZ` only, and the PATCH route then corrects it with `timeZoneFor`. | server, web | medium | M |
| 2.6 | **Types mirrored by hand between server and web.** `web/api.ts`, `web/importTypes.ts` (draft types) and `web/shortcuts.ts` (`CallingSettings`, the shortcut action list) copy server types. Drift already exists: the server sends `version` in meta and `api.ts` `Meta` does not declare it. | web | medium | M |
| 2.7 | **Same helper on both sides.** `api.ts` `personAge` copies the server's `ageOn`, and `fmtPhone` copies `formatUsPhone`. | web | low | S |
| 2.8 | **About seven `localStorage` wrappers.** CallingPage `store()`, UpdateBar, ImportPage (two), GroupPicker, LeadsPage, ReportsPage and App.tsx. All are safe, but each is written differently. | web | low | S |
| 2.9 | **Six date-range helpers.** CallsPage `dayRange`, LeadsPage `dayStart`, ReportsPage `rangeFor`, NumbersPage `todayRange`, App `TodayStats` and `when.ts` `startOfDay`. | web | low | S |
| 2.10 | **Upload code twice.** `BulkImport.tsx:155` `sendFile` reimplements `api.upload` and its error parsing, adding a retry. | web | low | S |
| 2.11 | **Copies inside the server.** `batchSchema` appears in `app.ts:567` and `importRoutes.ts`. The safe-filename sanitizer is in `app.ts:582` and `drafts.ts:682`. The problems.csv mapping is written twice in `app.ts` (601-613, 616-636). The `sqlite_master` table-list query appears in `exporter.ts` and twice in `backup.ts`. The PDF `getDocument` loop is in both `readPdfText` and `pdfTextTurns` (`pdfReader.ts`). The data-file loader is copied between `county.ts` and `areaCodes.ts`. The default lead type `'D'` is set in both `importRoutes.ts:227` and `drafts.ts:268`. | server | low | S each |
| 2.12 | **Two "today" activity definitions.** The top bar's `/api/stats/today` (`app.ts:425-444`) counts every call dated today. Reports (`reports.ts`) leaves out spreadsheet-history calls with `time_known=0`, so the two can show different numbers for the same day. **This might be intentional, so it needs a decision before anything changes (D3).** | server | low | S |
| 2.13 | **`zod` imported two ways.** `callingRoutes.ts` uses `zod/v4`; everything else uses `zod`. | server | low | S |
| 2.14 | **Three AI call patterns.** `ai/readers.ts` spawns the Claude Code CLI, calls the Anthropic SDK, and does a raw `fetch` for OpenAI-compatible servers. These are three back-ends, so three code paths are reasonable. Timeouts, retries and error shapes differ, though (see 4.6). | server | low | M |
| 2.15 | **Child processes spawned six ways.** `dialer.ts`, `ai/readers.ts`, `updates.ts`, `backup.ts` (age) and the updater scripts each set up timeouts, buffers and error handling differently. | server | low | M |

## 3. Security

| # | Finding | Where | Sev | Effort |
|---|---|---|---|---|
| 3.1 | **No committed secrets.** History scan clean (see Summary). `scripts/secret-scan.mjs` runs in CI. | — | — | — |
| 3.2 | **Local-auth design is sound.** Host allowlist (blocks DNS rebinding), token cookie, Origin check on non-GET requests, and CSP. The Electron window uses contextIsolation and sandbox, has nodeIntegration off, and `lockDownSession` restricts permissions. | `http/security.ts`, `desktop/main.ts` | — | — |
| 3.3 | **Unguarded `decodeURIComponent` on upload headers.** A malformed `x-file-name` throws a URIError, which surfaces as a 500 instead of a 400. Only an authenticated client can trigger it, and only that request is affected. `importRoutes.ts:180` already guards it correctly. | `app.ts:500`, `importRoutes.ts:72` | low | S |
| 3.4 | **Desktop updates are unsigned on Windows and Mac.** The Mac sha512 comes from `latest-mac.yml` on the same origin as the zip, so it only proves the download wasn't corrupted. It does not prove who published it. Trust rests entirely on the GitHub repo and release workflow. Fixing it needs code-signing certificates, which is outside a refactor. | `desktop/updater.ts` | medium | L |
| 3.5 | **Release on every push to `main`.** Anyone who can push to `main` ships to every installed copy. Branch protection with required checks would reduce this. It is a GitHub setting, not code (D8). | `.github/workflows/ci.yml` | medium | S |
| 3.6 | **CI actions are pinned by tag, not commit SHA.** The release job holds a `contents: write` token, so a hijacked action tag could publish a release. | `.github/workflows/ci.yml` | low | S |
| 3.7 | **The configurable `claude_code.command` runs any executable.** Anyone holding the access token can make the server spawn a chosen program. This is by design (it points at the user's Claude CLI) and gated by the token, so I am noting it rather than recommending a change. | `ai/readers.ts`, `ai/settings.ts` | low | — |
| 3.8 | **`/api/settings/ai/test` fetches a user-supplied `base_url`.** This is an SSRF-shaped capability, gated by the token and intended. | `importRoutes.ts` | low | — |
| 3.9 | **Linux launcher passes the token on the command line.** It goes in the `xdg-open` argv, which other local users can read in `ps`. This applies only to the systemd install path. | `scripts/mpcrm-open.sh` | low | S |
| 3.10 | **XLSX export lacks part of the formula guard.** The CSV guard also catches leading `\t` and `\r`; the XLSX guard does not. *Re-checked during S3:* ExcelJS stores these values as text cells, which Excel never evaluates, so there is no injection risk. Widening the guard would only add a visible apostrophe to more exported values. No change. | `domain/exporter.ts` | — | — |
| 3.11 | **Data at rest is unencrypted on Windows and Mac.** The DB holds health information, and `dump.json` exports always include it (the UI tooltip says so). Backups can be age-encrypted only if `MPCRM_BACKUP_AGE_RECIPIENT` is set. Disk encryption is presumably the user's job; this needs a decision on whether to document it (D9). | `backup.ts`, `exporter.ts` | low | S (docs) |
| 3.12 | **Shell use in the Linux updater is safe.** `git archive "${sha}"` is run through `sh -c`, but the sha comes from `git rev-parse`, so it cannot carry injected input. | `scripts/mpcrm-update.mjs` | — | — |
| 3.13 | **`npm audit`: 8 moderate findings, all build-time only.** The chain is `sprintf-js` → `roarr` → `global-agent` → `@electron/get`, inside `electron-builder`. None of it ships in the app. `npm audit fix --force` would downgrade electron-builder to 26.5.0, so don't run it; wait for an upstream fix. | `package-lock.json` | low | — |
| 3.14 | **Dependencies slightly behind.** `@anthropic-ai/sdk` is at 0.131 (latest 0.137), `electron` at 44.9.0 (45 is out), `pdfjs-dist` at 6.3 (6.4) and `vite` at 8.3.4 (8.3.5). Staying current on Electron matters for security patches. | `package.json` | low | S–M |

## 4. Reliability

| # | Finding | Where | Sev | Effort |
|---|---|---|---|---|
| 4.1 | **Shutdown closes the DB under running workers.** `stop()` stops only `PageChecker`, then calls `db.close()`. `DraftWorker` and `BulkImporter` keep running, and the next `db.prepare` throws. `DraftWorker.run`'s `.catch` (`drafts.ts:296`) itself calls `db.prepare`, so it likely ends in an unhandled rejection during quit or update-restart. This is inferred from the code; I did not reproduce it. | `server.ts:140-150` | high | S |
| 4.2 | **Draft commit is not atomic.** `commitRows` commits leads in its own transaction. After that come the file copy, the chmod and the `status='committed'` update, all outside it. If the copy fails (disk full, permissions), the leads are imported but the draft still looks uncommitted, and committing again would re-run the import. | `drafts.ts:665-690` | high | S |
| 4.3 | **`MPCRM_BACKUP_KEEP` is not validated.** `Number(env.MPCRM_BACKUP_KEEP \|\| 30)`. A value of 0 or below makes `pruneBackups` (`backup.ts:93-101`) delete every backup, including the one it just wrote. A non-numeric value becomes NaN, and then nothing is ever pruned. | `config.ts:42` | high | S |
| 4.4 | **Silent `.catch(() => {})` in the web app.** A failed request leaves the UI quietly stale. Locations: `GroupPicker:56`, `UpdateBar:31`, `App:58,160`, `ImportPage:45,134`, `CallingSettingsCards:45`, `SettingsPage:151`, `DataPage:17` and `NumbersPage:61`. | `src/web` | medium | S |
| 4.5 | **`RestoreBox.restore` has no error handling.** A failed restore gives the user no message. | `CallingPage.tsx:1004` | medium | S |
| 4.6 | **The Claude CLI reader can hang or flood memory.** It has a 180 s timeout but sends only SIGTERM (no SIGKILL fallback), and it buffers stdout without a limit. | `ai/readers.ts` | medium | S |
| 4.7 | **The web fetch client has no timeout.** A stuck request spins forever. | `web/api.ts` | low | S |
| 4.8 | **Backups block the event loop.** `gzipSync` at level 9 and `contentChecksum` (loads every row into memory) run synchronously. This is fine at today's DB sizes and will get worse as data grows. | `backup.ts` | low | M |
| 4.9 | **The desktop state file is not written atomically.** A crash mid-write corrupts `desktop.json`. | `desktop/main.ts:67` | low | S |
| 4.10 | **Two process-alive checks disagree.** `server.ts` `alive()` treats EPERM as alive; `backup.ts:141` `isAlive` does not. | `server.ts`, `backup.ts` | low | S |
| 4.11 | **The migration runner doesn't detect a database newer than the build.** After a downgrade, the app runs against a schema it doesn't know. Separately, parallel branches can pick the same migration number. | `db/connection.ts` | low | S |
| 4.12 | **`GET /api/counties` writes to the DB** (it calls `seedCountyAreaCodes`). A read endpoint with side effects. | `importRoutes.ts` | low | S |
| 4.13 | **Uploads are held in an in-memory map.** It is capped at 5 entries for 1 hour and lost on restart. Acceptable for a single-user app; noted for awareness. | `app.ts` | low | — |

## 5. Dead weight

| # | Item | Where | Sev | Effort |
|---|---|---|---|---|
| 5.1 | **Unused exports:** `pdfPageCount` (`pdfReader.ts`), `formatUsPhone`, `COUNTY_TIME_ZONES` and `parseYesNo` (`normalize.ts`; `parseYesNo` is only used inside that file), `mapRow`, `analyzeSheet` and `FIELD_LABELS` (`importer.ts`), and `toLocalInput` (`web/api.ts`). | various | low | S |
| 5.2 | **Routes the UI never calls:** `/api/queue` (`app.ts:149-158`, plus all of `domain/queue.ts`), `/api/imports/preview` (`app.ts:557-562`) and `/api/imports/commit` (`app.ts:564-587`). About five test files exercise `getQueue` and `commitImport`, so deleting them means moving those tests onto the paths in use (D2). | `app.ts`, `queue.ts` | low | M |
| 5.3 | **About 17 `eslint-disable` comments with no ESLint installed.** | `src/` | low | S |
| 5.4 | **`app.ts` re-exports `batchPdf`.** It is only there for an import path. | `app.ts` | low | S |
| 5.5 | **`docs/phase-0-plan.md` is out of date.** 861 lines describing the original plan; much of it no longer matches the code. | `docs/` | low | S |
| 5.6 | **`MPCRM_UPDATE_FEED` is a test-only hook in production code.** | `desktop/updater.ts` | low | — |

## 6. Config and environment

| # | Finding | Where | Sev | Effort |
|---|---|---|---|---|
| 6.1 | **Env vars are read in five places.** `config.ts` reads `MPCRM_DATA_DIR`, `MPCRM_PORT` (validated), `MPCRM_BACKUP_DIR`, `MPCRM_BACKUP_KEEP` (not validated, see 4.3) and `MPCRM_BACKUP_AGE_RECIPIENT`. The others: `MPCRM_APP_DIR` (`desktop/main.ts`, `server.ts`), `MPCRM_UPDATE_FEED` (`updater.ts`), `MPCRM_UPDATE_BRANCH`/`SERVICE`/`HEALTH_TIMEOUT_MS`/`UPDATE_BUILD_CMD` (`mpcrm-update.mjs`), `MPCRM_COMMIT` (build-info) and `CHROMIUM_PATH` (Playwright). | — | low | S |
| 6.2 | **Port 5170 is hardcoded five times:** `config.ts:32`, `mpcrm-update.mjs:25`, `mpcrm-open.sh:7`, `install.sh:188,191` and `vite.config.ts:40`. | — | low | S |
| 6.3 | **No `.env.example`.** The README documents 5 variables; the Linux env file lives at `~/.config/mpcrm/env`. | — | low | S |
| 6.4 | **The 23:30 backup time is set twice:** `backupSchedule.ts` and the `install.sh` systemd timer. | — | low | S |
| 6.5 | **`@types/qrcode` is listed under `dependencies`** instead of `devDependencies`, so it gets packaged. | `package.json` | low | S |
| 6.6 | **Logging is fragmented.** The server uses pino. Desktop `note()` writes a different JSON format, and its log rotates only at startup (5 MB). Stray `console.*` calls remain at `desktop/main.ts:19`, `server.ts:106` (PageChecker logs through `console.warn`) and `updates.ts:101`. | — | low | S |

## 7. Tests and tooling

| # | Finding | Sev | Effort |
|---|---|---|---|
| 7.1 | **The baseline is good.** 191 tests pass across 21 files; integration tests drive real routes through Fastify `inject`, and e2e covers the main flows on three operating systems. | — | — |
| 7.2 | **Routes with no HTTP-level test:** call-list skip and clear-worked, `calls/:id/outcomes`, `counties/area-codes`, drafts (commit, retry, rows, settings, type, sheet, file), `import-defaults`, `imports/:id/problems.csv`, `lead-links`, `lead-pages/check`, `lead-types`, leads (actions, called-back, notes) and `settings/ai/test`. Some of their domain logic is tested directly, but these routes are what step C3 will move, so they need characterization tests first. | medium | M |
| 7.3 | **No React component tests.** Only `when.ts` has unit tests. The web side is covered by e2e alone. | low | L |
| 7.4 | **Desktop `main.ts` and `updater.ts` are covered only by the CI smoke test.** `updateLogic.ts` has unit tests. | low | M |
| 7.5 | **No linter or formatter in CI,** and no coverage report. | medium | S |
| 7.6 | **`any` appears 109 times,** concentrated in `app.ts` (14), `CallingPage.tsx` (11) and `ReportsPage.tsx` (9). TypeScript strict mode is on, so these are deliberate escapes. | low | M |
| 7.7 | **Oversized files:** `app.ts` (693 lines; routes, SQL, error handler and upload store), `drafts.ts` (690; storage, assessment, worker, review and commit) and `CallingPage.tsx` (1045; seven components plus its own storage helper). In `pages/`, `CallingSettingsCards.tsx` and `BulkImport.tsx` are not pages (BulkImport has module-level state), and the names `LeadView`, `LeadViewer` and `LeadPage` are easy to confuse. | medium | M |

## Relation to the earlier audit

`plan/audit-2026-10-17.md` (project folder) was a feature-level review: bugs, speed wins S1-S5 and data fixes D1-D6. The README shows most of those have shipped. This audit is structural and does not re-check those items.
