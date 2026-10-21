## What changed and why

## Fits the existing structure

- [ ] Reuses the shared pieces in `CLAUDE.md` (errors, settings, audit log, API client, date helpers) instead of adding a new copy, or the PR explains why it can't
- [ ] No new SQL in route files; queries live in `src/server/domain/`
- [ ] Failures are shown to the user or logged, not swallowed
- [ ] New migration (if any) takes the next free number and doesn't clash with other open PRs

## Behavior

- [ ] No user-visible change, or the change is described above
- [ ] Tests added or updated for the new behavior

## Checks

- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass
