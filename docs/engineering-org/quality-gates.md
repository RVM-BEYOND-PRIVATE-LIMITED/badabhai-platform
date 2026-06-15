# Quality Gates

No change merges to `main` unless it clears these gates. They are calibrated for
a **2–5 person team**: automation does the heavy, repeatable checking; exactly
**one human reviewer** is assumed (not a committee). Where we'd normally want a
separate human role (security, performance), the corresponding **agent** performs
the review and the human reviewer confirms it was done.

The PR is not mergeable until every applicable box is checked. "N/A" is a valid
answer but must be deliberate, not skipped.

---

## The seven gates

### ✅ 1. Architecture approved
- Change respects the seams: event-first, repository/service separation, AI
  privacy boundary, typed contracts (see [principles](./README.md#operating-principles-inherited-non-negotiable)).
- Heavyweight changes (new table, event-version bump, new provider, auth/RLS, AI
  boundary) have an [ADR](../decisions/) **or** a logged [team-decision](../registers/team-decisions.md).
- **Enforced by:** System Architect agent review + reviewer confirmation.

### ✅ 2. Security & privacy reviewed
- **No raw PII reaches any LLM** (phone, name, address, employer, ID). The
  [pseudonymization gateway](../ai/pseudonymization.md) stays **fail-closed**.
- No PII in `events`, `ai_jobs`, `audit_logs`, or logs — ids/hashes only.
- No secrets or `.env` committed. New PII columns live only in `workers`.
- Mandatory for any change touching auth, RLS, secrets, PII, or AI; recommended
  for all.
- **Enforced by:** Security Engineer agent + [`bb-security-review`](../../.claude/skills/bb-security-review/SKILL.md);
  CI secret scan; PR template privacy checklist.

### ✅ 3. Tests pass
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` green (TS monorepo).
- `ruff check` + `pytest` green (AI service). Flutter `analyze` + `test` green
  (worker-app) — **blocking** as of 2026-06-15, runs only on PRs touching
  `apps/worker-app` (TD7 paid).
- New behavior has new tests. Privacy/event-critical paths have explicit assertions.
- **Enforced by:** [CI workflow](../../.github/workflows/ci.yml) +
  [Worker app workflow](../../.github/workflows/worker-app.yml) (both blocking on `main`).

### ✅ 4. Performance acceptable
- No new N+1 queries; new query patterns are indexed. Slow work (extraction,
  transcription, future ranking) is queued (BullMQ), not inline on the request.
- Payloads and event volumes are bounded.
- **Enforced by:** Performance Engineer agent for hot-path/query/AI-loop changes;
  N/A for most trivial changes.

### ✅ 5. Documentation updated
- README / architecture / schema / event docs touched where the change affects
  them. New ADR for heavyweight decisions. Registers updated.
- **Enforced by:** Technical Writer agent + reviewer; PR template docs checkbox.

### ✅ 6. Code review passed
- One human reviewer approves. The [`bb-code-review`](../../.claude/skills/bb-code-review/SKILL.md)
  skill (or `/code-review`) has been run and its findings resolved.
- Reads like the surrounding code; no `any`, no dead code, no commented-out blocks.
- **Enforced by:** branch protection on `main` (1 approval) + Code Reviewer agent.

### ✅ 7. No critical bugs
- No known data-loss, privacy-leak, auth-bypass, or crash-on-happy-path issues.
- Migrations are backward-compatible and have a written rollback.
- **Enforced by:** reviewer judgment + Debugging agent for any flagged defect.

---

## Severity → action

| Severity | Definition | Action |
| -------- | ---------- | ------ |
| **Critical** | PII leak to LLM/logs, auth bypass, data loss, fail-open AI path | **Block merge.** Fix or revert. Log in [risks](../registers/risks-register.md). |
| **High** | broken core flow, missing event on important endpoint, unsafe migration | Block merge until fixed. |
| **Medium** | missing test, perf regression on a warm path, doc gap | Fix in PR, or log in [tech-debt](../registers/tech-debt-register.md) with an owner + trigger. |
| **Low** | style, naming, minor cleanup | Fix in PR or follow-up; reviewer's discretion. |

A **Critical** finding is never deferred to tech-debt. The privacy and
fail-closed guarantees are not negotiable trade-offs.

---

## What we deliberately do NOT gate on (Phase 1)

To stay honest about scope (these are tracked, not enforced):
- **Finalized RLS** — backend uses the service role in Phase 1; RLS is
  [planned](../../infra/supabase/rls-plan.md), tracked in [risks](../registers/risks-register.md).
- **Coverage thresholds** — we require tests for new behavior, not a global %
  number, until the suite matures.

When these graduate from "tracked" to "enforced," update this doc and CI together.
