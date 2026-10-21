# Stabilization plan (Phase 2)

Based on [AUDIT.md](AUDIT.md). **Status: waiting for approval. No refactoring has started.** Reorder or cut steps freely; each one ships on its own.

## Ground rules for every step

- One PR per step. `main` releases on every push, so small PRs keep each release easy to reason about and easy to revert.
- No user-visible behavior changes unless a decision below approves one.
- Characterization tests come before any change to untested code.
- `npm run typecheck`, `npm test` and the build must pass before each push (plus lint, once step T1 adds it).
- None of these steps adds a migration, so they can't collide with migration numbers in other work (for example, a likely 017 from the call-history bulk-edit work).
- File moves (C6) wait until no other PRs are open, so they don't create merge conflicts.

## Target architecture

```
src/
  shared/                 # types and pure helpers used by both server and web
    types.ts              #   API shapes now mirrored in web/api.ts, importTypes.ts, shortcuts.ts
    phone.ts, age.ts, time.ts
  server/
    core/                 # foundations every feature uses
      config.ts           #   all env parsing and validation in one place
      errors.ts           #   DomainError (moved from domain/calls.ts), plus the zod-to-400 helper
      settings.ts         #   getSetting/setSetting (moved from ai/settings.ts)
      audit.ts            #   the one way to write audit_log
      sql.ts              #   shared fragments: current outcome, lead name, table list
      jobs.ts             #   only if R1 shows the three workers need a shared stop/drain shape
    calling/  imports/  reports/  backup/  updates/  ai/  leads/
                          # feature folders: domain logic plus a routes.ts with no SQL
    http/                 # app setup, security, error handler, route registration
    db/
  web/
    lib/                  # api.ts, storage.ts, dates.ts, format.ts
    pages/<Page>/         # big pages split into their parts
    components/
  desktop/                # unchanged layout
```

**Why each major decision:**

- **`src/shared/`.** Hand-mirrored types have already drifted (`Meta.version`). A shared folder lets the compiler catch the next drift. It holds types and pure functions only, nothing that touches Node or the DOM, so both builds can import it.
- **`server/core/`.** Every feature already depends on errors, settings and audit, but those live inside one feature's files (`calls.ts`, `ai/settings.ts`). Moving them out removes cross-feature imports without adding anything new.
- **Feature folders, done last.** The flat `domain/` folder works today. Moving files touches every import, so it comes at the end, once the content is clean, and only when no PRs are open. If you'd rather keep the flat layout, cut C6; the other steps don't depend on it.
- **No SQL in routes.** Routes validate input and call a function, and the function owns the query. Characterization tests can then call the domain function directly.
- **No new framework.** No DI container, ORM or repository layer. A `jobs.ts` helper appears only if R1 shows the three workers need the same stop/drain shape; otherwise each one just gets a `stop()`.

## Shared foundations, and who moves onto them

| Foundation | What it replaces | Features that migrate |
|---|---|---|
| `core/config.ts` | Env reads in `config.ts`, `desktop/main.ts`, `server.ts` and `updater.ts`; unvalidated `BACKUP_KEEP` | server, desktop (scripts keep their own reads, since they run outside the build) |
| `core/errors.ts` | `DomainError` in `calls.ts`, `MappingError`, plain `Error` throws, per-route rewraps, the `e?.issues` duck-typing | every route file and domain module that throws |
| `core/settings.ts` | `getSetting`/`setSetting` in `ai/settings.ts` | calling settings, imports defaults, AI, backup schedule |
| `core/audit.ts` | `app.ts` `audit()`, inline inserts in `importRoutes.ts` and `areaCodes.ts` | leads, imports, numbers, area codes |
| `core/sql.ts` | The repeated current-outcome subquery and table-list query | reports, leads, exporter, backup |
| Logging | `console.*` at `server.ts:106` and `updates.ts:101` | PageChecker and updates switch to the pino logger. The desktop log format is left alone. |
| Validation | Duplicate `batchSchema`; `zod` vs `zod/v4` | imports, calling |
| `web/lib/storage.ts`, `dates.ts` | About 7 `localStorage` wrappers and 6 date-range helpers | every page |

## Ordered steps

### Security and safety

| Step | Change | Audit | Size |
|---|---|---|---|
| **S1** | ✅ Validate `MPCRM_BACKUP_KEEP` (needs D4) | 4.3 | S |
| **S2** | ✅ Guard `decodeURIComponent` on upload headers. A badly encoded name now falls back to the default name (as the bulk-import route already did) instead of returning 500. | 3.3 | S |
| **S3** | ❎ Dropped: XLSX values are stored as text and never evaluated (see audit 3.10) | 3.10 | — |
| **S4** | ✅ Pin CI actions to commit SHAs; move `@types/qrcode` to devDependencies | 3.6, 6.5 | S |
| **S5** | (Your action) branch protection on `main` with required checks | 3.5 | S |

### Tests and tooling

| Step | Change | Audit | Size |
|---|---|---|---|
| **T1** | ✅ Done with **oxlint** instead of ESLint: typescript-eslint doesn't support TypeScript 7, and oxlint reads TypeScript directly and honors the existing `eslint-disable` comments. Also added `scripts/check-structure.mjs` (stops new SQL in routes, new silent catches and new server `console.*`) and a PR checklist. Originally: Add ESLint with typescript-eslint and react-hooks, and run it in CI. Fix or justify the existing `eslint-disable` comments. New dev dependencies, so it needs D6. | 7.5, 5.3 | M |
| **T2** | ✅ HTTP characterization tests for every untested route in audit 7.2 | 7.2 | M |
| **T3** | ✅ A test that stops the server while a draft and a bulk import are running (fails until R1) | 4.1 | S |

### Reliability

| Step | Change | Audit | Size |
|---|---|---|---|
| **R1** | ✅ `stop()` and drain `DraftWorker` and `BulkImporter` before `db.close()` | 4.1 | S |
| **R2** | ✅ Make draft commit safe to fail: copy the file first, then commit rows and mark the draft committed in one transaction | 4.2 | S |
| **R3** | ✅ Show web request failures instead of swallowing them, and handle `RestoreBox` errors. Errors would now appear where none showed before. | 4.4, 4.5 | S |
| **R4** | ✅ Claude CLI reader: SIGKILL after the timeout, and cap stdout | 4.6 | S |
| **R5** | ✅ (in part: atomic `desktop.json` and one running-check rule. Refusing a newer database was dropped: databases that ran the removed migration 006 would be refused, and after a rolled-back update the app wouldn't open.) Atomic `desktop.json` write; one shared process-alive check; refuse to start on a database newer than the build | 4.9–4.11 | S |
| **R7** | ✅ Top-bar today stats leave out spreadsheet-history calls without a time, matching Reports (approved behavior change, D3) | 2.12 | S |
| **R6** | (Can defer) Move backup gzip and checksum off the event loop | 4.8 | M |

### Structure

| Step | Change | Audit | Size |
|---|---|---|---|
| **C1** | ✅ Done. The table-name helper went to `db/connection.ts` (`tableNames`) instead of a new `core/sql.ts`, and zod errors already reach the one error handler. Originally: `core/errors.ts`, `core/settings.ts`, `core/audit.ts`, `core/sql.ts`, and one shared zod-to-400 path. Moves and re-exports only, no behavior change. | 2.1, 2.2, 2.11, 2.13 | M |
| **C2** | ✅ Server env reads now go through `config.ts` (`MPCRM_APP_DIR` was read in two other places), and the page checker logs through the server logger. The remaining `console.*` calls run where no logger exists, each with a reason in the structure check. No `core/config.ts`: `config.ts` already is that file. Originally: Route `console.*` through the logger; collect the env reads into `core/config.ts` | 6.1, 6.6 | S |
| **C3** | ✅ Route files now hold no SQL (the structure check enforces 0), and `app.ts` is split into lead, number, data, import, calling and report route files. Originally: Move SQL out of `app.ts`/`importRoutes.ts` into domain functions; split `app.ts` into per-feature route files | 2.3, 7.7 | M |
| **C4** | ✅ `src/shared/` holds the calling settings schema, the draft review and progress types, and `ageOn`. The bigger response shapes (lead detail, draft view) stay mirrored for now: the server builds them untyped, so sharing them means typing those functions first. Originally: Create `src/shared/` and move the mirrored types and the duplicate helpers into it (needs D5) | 2.6, 2.7, 2.5 | M |
| **C5** | ✅ Done, with `storage.ts` and the day helpers beside `when.ts` rather than in a new `lib/` folder, to match how `src/web` is laid out. `LeadPage` → `SourcePage`, `LeadView` → `LeadDetails`; `LeadViewer` keeps its name. Originally: Web: `lib/storage.ts`, `lib/dates.ts`, `BulkImport` reuses `api.upload`; split `CallingPage.tsx`; rename the confusing Lead* components | 2.8–2.10, 7.7 | M |
| **C6** | Move files into feature folders (only when no PRs are open) | 1 | M |

### Cleanup

| Step | Change | Audit | Size |
|---|---|---|---|
| **X1** | ✅ Delete the dead exports in audit 5.1 | 5.1 | S |
| **X2** | ✅ Delete `/api/queue`, `queue.ts` and the one-step import routes, moving their tests onto the routes in use (needs D2) | 5.2 | M |
| **X3** | ❎ Dropped after a closer look. The port: each place already reads `MPCRM_PORT`; only the default `5170` repeats, in a bash script, the updater script and the Vite config, which can't share code with the app without new coupling. The token in `xdg-open`: the browser gets the link in its own command line anyway, so hiding it from `xdg-open` alone wouldn't help, and anything that would (opening a local redirect file) changes how the app opens. Originally: Keep the Linux systemd path (D1), with no behavior change. Only small tidy-ups: read the port from one place, and stop passing the token in `xdg-open` argv if that can be done without changing how the app opens. | 3.9, 6.2 | S |
| **X4** | ✅ Done. `env.example` (not `.env.example`, since nothing loads a `.env` file) lists every variable. The README also gets the right outcome keys (the table still said 1–5 with 4 as Bad number) and the encryption note for every system (D9). Originally: Mark `docs/phase-0-plan.md` as historical; add `.env.example`; update the README with structure, run/test/config instructions and conventions | 5.5, 6.3 | S |

## Risks

- **`main` auto-releases.** Any regression reaches users on the next update. Small PRs, green CI and characterization tests reduce this; branch protection (S5) would make it enforced rather than voluntary.
- **Large moves (C3, C6) conflict with parallel work.** Schedule them when nothing else is open.
- **R3 makes errors visible.** Users may see messages for failures that were always happening silently. That is the point of the step, but it will look like new behavior.
- **The web app has no component tests,** so web refactors (C5) lean on e2e plus manual checks.

## Decisions needed

| # | Question | My recommendation |
|---|---|---|
| D1 | Keep the Linux systemd / build-from-source install, or retire it in favor of the AppImage? | **Decided 2026-10-21: keep it.** It is how Alistair's own Linux computer updates (one click in the app), and AppImage updates have been unreliable for him. |
| D2 | Delete the unused `/api/queue` and one-step import routes? | **Decided 2026-10-21: delete them if the UI does not use them; move their tests.** |
| D3 | Should the top-bar "today" stats count spreadsheet-history calls dated today, which Reports leaves out? | **Decided 2026-10-21: no, because those calls have no real time.** Align `/api/stats/today` with Reports (new step R7). |
| D4 | Invalid `MPCRM_BACKUP_KEEP`: refuse to start, or fall back to 30 with a warning? | Fall back to 30 with a warning, and treat values below 1 as 1. Backups keep running instead of the app failing to start. |
| D5 | OK to add `src/shared/`? | Yes. |
| D6 | Add ESLint as a dev dependency? Prettier too? | **Decided 2026-10-21: ESLint yes.** Skip Prettier: it would reformat every file in one big diff. |
| D7 | Add a coverage tool? | Not now. |
| D8 | Turn on branch protection for `main`? | Yes (your GitHub setting). |
| D9 | Unencrypted local data, which includes health data: document it, or do more? | Document it in the README. |
