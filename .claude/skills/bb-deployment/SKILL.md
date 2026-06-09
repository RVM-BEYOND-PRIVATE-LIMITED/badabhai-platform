---
name: bb-deployment
description: Ship a change safely — migration ordering, safe-default env gates, CI green, and a written rollback. Use during the Deployment stage for anything beyond a trivial change.
---

# Skill: Deployment

**Goal.** Get a change live without breaking the running system, with a rollback
ready if it does.

**Inputs.** The merged change; its migration + env impact; the
[CI workflow](../../../.github/workflows/ci.yml); the infra docs under `infra/`.

**Process.**
1. Confirm CI is green (`pnpm lint/typecheck/test/build`, `ruff`+`pytest`).
2. Sequence migrations **before** the code that depends on them; confirm they're
   backward-compatible (expand→migrate→contract for risky ones).
3. Verify env gates default safe: `AI_ENABLE_REAL_CALLS=false`, no real provider
   keys enabled in a shared env without sign-off; server/public split intact.
4. Write the rollback: how to revert code + any data/migration considerations.
5. Deploy; verify health (`/health`), events flowing, and the change visible in ops.
6. Watch logs for the first window after deploy.

**Checklist.**
- [ ] CI green across TS + AI service.
- [ ] Migration applied before dependent code; backward-compatible.
- [ ] Env gates safe-default; no secret/real-key surprise.
- [ ] Rollback written in the PR.
- [ ] Post-deploy health + events + ops visibility confirmed.
- [ ] Logs watched in the first window.

**Expected Output.** A deployed change with verified health, a written rollback,
and confirmation it's observable.

**Failure Conditions.** Code shipped before its migration; a flag/key enabled
unsafely; no rollback path; "deployed" declared without verifying health/events.
