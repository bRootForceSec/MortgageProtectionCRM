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
| Add business logic or queries | `src/server/domain/<feature>.ts`. Domain functions take `db` and know nothing about HTTP. |
| Signal a user-facing error | `throw new DomainError(message, status?)` from `src/server/core/errors.ts`. The error handler turns it into a 4xx with `{ error }`. Don't throw a plain `Error` for user mistakes, and don't catch and rewrap errors in routes. |
| Store a setting | Use `getSetting` / `setSetting` from `src/server/core/settings.ts` (`app_setting` table). Don't create a new settings table or file. Secrets go in `Secrets` (0600 `secrets.json`), never in the DB. |
| Record who changed what | `audit(db, table, rowId, action, old, new)` from `src/server/core/audit.ts`, inside the same transaction as the change. Don't write `INSERT INTO audit_log` by hand. |
| Change the schema | Add the next numbered file in `src/server/db/migrations/`. Check open PRs first so two branches don't take the same number. Never edit a migration that has shipped. 006 is missing on purpose. |
| Read config or env vars | `src/server/config.ts` (`loadConfig`). Validate there, not where the value is used. |
| Log on the server | Use the pino logger (`app.log` or `req.log`), not `console.*`. |
| Run a background job | Look at `DraftWorker`, `BulkImporter` and `PageChecker` first. A new job must stop cleanly when the server stops (`server.ts` `stop()`). |
| Call the API from the UI | `src/web/api.ts` (`api.get`, `api.post`, `api.upload`). Don't write a new fetch wrapper. |
| Show a failure in the UI | Show the user a message. Don't write `.catch(() => {})` unless failing really is harmless, and if so, add a comment saying why. |
| Remember a UI preference | Reuse an existing `localStorage` helper. Wrap access in try/catch. |
| Work with dates and time zones | Web: `src/web/when.ts`. Server: `domain/normalize.ts` (`timeZoneFor`). Don't write another day-range or time-zone offset helper. |
| Share a type between server and UI | For now, mirror it in `src/web/api.ts` and update both sides in the same PR. |

## Data rules

- **`lead_state` is derived.** Change the source tables and rebuild (`rebuildLeadState`); never edit `lead_state` directly.
- **Outcomes are append-only.** A change adds a new outcome that supersedes the old one. Calls are voided, not deleted.
- **Health fields** (`tobacco_raw`, `health_*_raw`) are excluded from exports unless the user asks for them. Keep it that way.

## Style

- Strict TypeScript. Avoid `any` in new code.
- Import zod as `import * as z from 'zod/v4'`, like the rest of the code.
- Match the file you're in. Don't add a library for something a few lines can do, and ask before adding a dependency.
- Prefer deleting code to adding abstractions. Don't build a helper or layer with only one user.

## Ongoing stabilization

`AUDIT.md`, `PLAN.md` and `REFACTOR_NOTES.md` track the current clean-up. Where this file says "currently in X", the plan moves that piece to a shared place (`src/server/core/`, `src/shared/`, `src/web/lib/`). When that happens, update this file in the same PR.
