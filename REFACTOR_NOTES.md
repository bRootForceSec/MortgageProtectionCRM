# Refactor notes

A running log of the stabilization work. Newest first.

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
