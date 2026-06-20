---
name: release-check
description: Release readiness and rollback verification — CI green, migration ordering, safe-default env gates, smoke test, immutable deploy tag, and a rehearsed rollback. Use before shipping; pairs with bb-deployment.
---

# Skill: Release Check

**Goal.** Ship without breaking the running system, with a rollback proven to work.

**Inputs.** The merged change; its migration + env impact; the
[CI workflow](../../../.github/workflows/ci.yml); infra docs under `infra/`; `docs/release-checklist.md`
and `docs/rollback-guide.md` (Phase 9).

**Process.**

1. **CI green** across TS + AI service (+ Flutter if touched); the E2E gate passed.
2. **Migrations** sequenced before dependent code; backward-compatible; applied to staging first.
3. **Env gates safe-default:** `AI_ENABLE_REAL_CALLS=false`, no real provider keys enabled in a
   shared env without sign-off; server/public split intact.
4. **Immutable artifact:** deploy a tagged/immutable build so rollback = redeploy the previous tag.
5. **Smoke test** post-deploy: `/health`, one critical flow, events flowing, change visible in ops.
6. **Rollback rehearsed:** know the exact revert (previous tag) and any data/migration caveats
   (a contracted/dropped column can't be un-dropped — verify this release is expand-only).
7. Watch logs / error rate for the first window.

**Checklist.**

- [ ] CI + E2E green; staging validated.
- [ ] Migrations backward-compatible, applied before code; this release is expand-only or has a data plan.
- [ ] Env/flags safe-default; no secret/key surprise.
- [ ] Immutable tag deployed; previous good tag known.
- [ ] Smoke test passed; rollback steps written and feasible.

**Expected Output.** A go/no-go with the deployed tag, the smoke-test result, and a concrete rollback plan.

**Failure Conditions.** Code shipped before its migration; a non-reversible migration with no plan;
"deployed" declared without a smoke test; no known-good tag to roll back to.

**See also.** [`bb-deployment`](../bb-deployment/SKILL.md) · agent
[`devops-engineer`](../../agents/devops-engineer.md).
