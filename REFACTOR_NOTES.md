# Refactor notes

A running log of the stabilization work. Newest first.

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
