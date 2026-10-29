# Working on Mortgage Protection CRM

Read this before changing code. New features must fit the existing structure. Don't add a parallel copy of something that already exists. If what you need is missing or wrong, change the shared piece and mention it in the PR.

## What this is

- **A single-user desktop CRM.** An Electron shell (`src/desktop/`) starts a Fastify server (`src/server/`) on 127.0.0.1:5170, which serves a React UI (`src/web/`). Data lives in SQLite (better-sqlite3, WAL).
- **It ships two ways.**
  - The desktop app (Windows, Mac and Linux AppImage) updates itself from GitHub Releases.
  - The Linux systemd service (`scripts/install.sh`, `scripts/mpcrm-update.mjs`) builds from `main`. It is the owner's main Linux setup, so keep it working.
- **Every push to `main` is a release.** Keep each change small and shippable on its own, with green CI.

## Before you push

- Run `npm run typecheck`, `npm run lint` and `npm test`, and `npm run build` if you touched the build or assets.
- `npm run lint` runs oxlint (React hook rules and common mistakes) and `scripts/check-structure.mjs`. The structure check stops new SQL in route files, new silent `.catch(() => {})` in the UI, hand-written `audit_log` inserts and new `console.*` in the server. If you remove some, lower the allowance in that script as it tells you to. Never raise one to get a change through.
- Run `npm run test:e2e` for UI flows when you can.
- Write a test for new behavior. Before refactoring untested code, first add a test that pins its current behavior.
- Never commit secrets. CI runs `scripts/secret-scan.mjs`.
- Don't change user-visible behavior as a side effect of a refactor. If a change alters what the user sees, say so in the PR.

## Where things go

| You need to… | Do this |
|---|---|
| Add an endpoint | Put it in the route file for its feature (`src/server/http/*Routes.ts`). Keep the handler thin: validate input with zod, call a domain function, return the result. **No SQL in route files** (the structure check enforces it). |
| Find the route file | `importRoutes` (uploads, drafts, bulk import, import history), `leadRoutes` (leads, call list, lead page, calls and outcomes), `callingRoutes`, `numberRoutes` (caller IDs and their checks), `reportRoutes`, `dataRoutes` (export and backups), `unitrustRoutes` (what the Unitrust Firefox extension sends, and its key). `app.ts` only wires these together. |
| Add business logic or queries | `src/server/domain/<feature>.ts`. Domain functions take `db` and know nothing about HTTP. Shared SQL pieces are in `db/sql.ts`: `CURRENT_OUTCOME` (a call's outcome that nothing supersedes, over `call_outcome o`), `LEAD_NAME` (over `lead l`) and `sqlList`. Use them instead of writing those out again. |
| Signal a user-facing error | `throw new DomainError(message, status?)` from `src/server/core/errors.ts`. The error handler turns it into a 4xx with `{ error }`. Don't throw a plain `Error` for user mistakes, and don't catch and rewrap errors in routes. |
| Store a setting | Use `getSetting` / `setSetting` from `src/server/core/settings.ts` (`app_setting` table). Don't create a new settings table or file. Secrets go in `Secrets` (0600 `secrets.json`), never in the DB. |
| Record who changed what | `audit(db, table, rowId, action, old, new)` from `src/server/core/audit.ts`, inside the same transaction as the change. Don't write `INSERT INTO audit_log` by hand. |
| Change the schema | Add the next numbered file in `src/server/db/migrations/`. Check open PRs first so two branches don't take the same number. Never edit a migration that has shipped. 006 is missing on purpose. Outcomes aren't schema: see the outcome row below. |
| Read config or env vars | `src/server/config.ts` (`loadConfig`). Validate there, not where the value is used. |
| Log on the server | Use the pino logger (`app.log` or `req.log`), not `console.*`. |
| Run a background job | Look at `DraftWorker`, `BulkImporter` and `PageChecker` first. A new job must stop cleanly when the server stops (`server.ts` `stop()`). |
| Call the API from the UI | `src/web/api.ts` (`api.get`, `api.post`, `api.upload`, which takes extra headers). Don't write a new fetch wrapper. |
| Show a failure in the UI | Show the user a message. Don't write `.catch(() => {})` unless failing really is harmless, and if so, add a comment saying why. |
| Load lead types in the UI | `useLeadTypes` from `src/web/leadTypes.ts`. |
| Remember a UI preference | `getStored` / `setStored` (or the `Json` versions) from `src/web/storage.ts`. Don't touch `localStorage` directly (the structure check enforces it). |
| Work with dates and time zones | Web: `src/web/when.ts` (`startOfDay`, `addDays`, `dayRange`, `todayRange`, `ymd`, and the callback parsing). Server: `domain/normalize.ts` (`timeZoneFor`). Age from a date of birth: `src/shared/age.ts` (`ageOn`). Don't write another day-range or time-zone offset helper. |
| List or pick batches | `src/web/components/BatchBrowse.tsx` (`BatchPicker`, `BatchFilterBar`, `ImportHistory`), backed by `browseImports` (`/api/imports/browse`). Filtering and grouping by bulk import live in `src/shared/batches.ts`. Don't add another plain list or dropdown of every batch. |
| Change how Unitrust appointments are read | The Firefox extension is in `extension/unitrust/` (plain JS, no build; see its README). It posts to `/api/unitrust/events` with its own key, the one request that skips the cookie (`security.ts`). Storing and matching: `domain/unitrustAppointments.ts`; colors and titles: `src/shared/appointments.ts`. |
| Add or change a call outcome (either side) | Edit `OUTCOMES` in `src/shared/outcomes.ts`, and nothing else: label, side (`kind`), key, pickup, callback, booked, appointment set, appointment result. The server copies it into the `outcome_code` table when it opens the database (`db/outcomeCodes.ts`), so SQL can join on it. Never remove an outcome calls may carry; set `active: false`. Don't touch `outcome_code` in a migration (a test checks). In code, test what an outcome means (`outcomeDef(code)?.apptSet`, `BOOKED_CODES`, `sqlCodes(...)` in SQL), never its code. An appointment call logged in the app beats the Unitrust color for that appointment (`deriveLeadState`, `appointmentsOnDays`). Objections per call: `domain/objections.ts`; which outcomes offer the chips is `objections` in `OUTCOMES`. |
| Change lead statuses, Leads tabs, appointment results or funnel steps | Statuses (label, callable, timeless) and the Leads tabs: `src/shared/leadStatus.ts`. Appointment results (label, back on the list, tab, funnel steps, Unitrust color): `APPT_RESULTS` in `src/shared/appointments.ts`. Funnel step names and order: `src/shared/funnel.ts`. Use `isCallable(status)` and `sqlList(CALLABLE_STATUSES)` (`db/sql.ts`), never a hand-written `'new', 'retry', 'callback'`. Which side a lead opens on: `openingSide`. |
| Share a type or helper between server and UI | Put it in `src/shared/` and import it from both sides (server: `'../../shared/x.js'`, web: `'../shared/x'`). Code there must run in both Node and the browser: no `node:` imports and nothing from `server/`, `web/` or `desktop/` (the structure check enforces it). Response shapes not moved yet are still mirrored in `src/web/api.ts` and `src/web/importTypes.ts`; when you change one, update both sides in the same PR. |

## Data rules

- **`lead_state` is derived.** Change the source tables and rebuild (`rebuildLeadState`); never edit `lead_state` directly.
- **A lead has any number of phone numbers.** The main one is on `lead` (`phone_e164`); the rest are rows in `lead_other_phone`, in order, read and written through `domain/leadPhones.ts`. To find leads by a number, use the `lead_number` view (every number of every lead), not `lead.phone_e164` alone.
- **Outcomes are append-only.** A change adds a new outcome that supersedes the old one. Calls are voided, not deleted.
- **Health fields** (`tobacco_raw`, `health_*_raw`) are excluded from exports unless the user asks for them. Keep it that way.

## Style

- Strict TypeScript. Avoid `any` in new code.
- Import zod as `import * as z from 'zod/v4'`, like the rest of the code.
- Match the file you're in. Don't add a library for something a few lines can do, and ask before adding a dependency.
- Prefer deleting code to adding abstractions. Don't build a helper or layer with only one user.

## Ongoing stabilization

`AUDIT.md`, `PLAN.md` and `REFACTOR_NOTES.md` track the current clean-up. Where this file says "currently in X", the plan moves that piece to a shared place (`src/server/core/`, `src/shared/`, `src/web/lib/`). When that happens, update this file in the same PR.
