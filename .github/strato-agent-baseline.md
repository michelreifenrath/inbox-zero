# Strato/IMAP agent baseline

Use this note as the baseline contract for Strato/IMAP issue branches.

- Branch later Strato/IMAP work from `strato-support` in the fork at `origin`.
- The baseline parent for issue #2 was verified at `6190a879d` and matched `origin/strato-support`, `origin/main`, and `upstream/main` before this note was added.
- Keep local experiments out of implementation branches unless they are explicitly scoped to the current issue.
- Issue #2 intentionally adds no Strato provider, schema, UI, auth, or runtime behavior changes.

## Targeted baseline checks

Run these from the repository root before opening Strato/IMAP PRs that depend on this baseline:

```bash
corepack pnpm --dir apps/web exec cross-env RUN_AI_TESTS=false vitest --run utils/email/rate-limit.test.ts utils/email/watch-manager.test.ts
corepack pnpm --dir apps/web exec prisma validate
```
