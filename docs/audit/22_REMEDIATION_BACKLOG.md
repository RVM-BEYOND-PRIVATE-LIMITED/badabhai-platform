# 22 — Remediation Backlog

Every actionable item this audit surfaced, prioritized. **P0** = production/security/data
integrity risk, **P1** = architecture/operational risk, **P2** = maintainability, **P3** =
cosmetic/documentation. Nothing here has been actioned — each item still needs its own
individually-reviewed, individually-verified PR per the audit's safe-deletion protocol (see
[23_REMEDIATION_PLAN.md](23_REMEDIATION_PLAN.md)).

**P0: none.** This batch found no Critical or High security finding, no confirmed production
outage risk, and no data-integrity issue — see [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md).

## P1 — architecture / operational risk

### BL-1 — Deployment path unknown for apps/web, apps/payer-web, apps/admin-web
- **Category**: Deployment/observability gap
- **Problem**: no Dockerfile, no docker-compose service entry, and no CI deploy job references
  any of the three internal/external Next.js apps anywhere in `.github/workflows/`. They
  compile via the generic Turborepo CI step, so we know they build — but this audit found no
  in-repo evidence of where, or whether, they're actually hosted.
- **Evidence**: [01_SYSTEM_BOUNDARY.md](01_SYSTEM_BOUNDARY.md) §apps/web/payer-web/admin-web
- **Current behavior**: unknown from repo evidence alone
- **Proposed change**: none — this needs a direct answer from Frontend Platform / DevOps
  (manual deploy? a pipeline that isn't checked in? genuinely not yet deployed?), not a code
  change
- **Files/APIs/DB/CI affected**: none directly; answer may lead to a future CI/deploy addition
- **Risk**: none from asking; risk of NOT asking is an undocumented production surface
- **Verification**: confirm with the app owners, then document the answer in
  `docs/operations/COMMANDS.md` (Batch 2)
- **Priority**: P1 — **Dependency**: none — **Complexity**: trivial (a conversation, not code)

### BL-2 — Two production ai-service routes have no HTTP-level test
- **Category**: Test coverage gap
- **Problem**: `POST /profiling/turn` (only its internal parser is unit-tested) and
  `POST /profiling/extract` (no dedicated test file — only appears in the generic auth-sweep
  test) are both Class-A production routes wired from `apps/api`, unlike every other Class-A
  ai-service route which has direct `TestClient` coverage.
- **Evidence**: [03_API_INVENTORY.md](03_API_INVENTORY.md) §apps/ai-service
- **Current behavior**: these two routes are exercised in production without a regression net
  at the HTTP layer
- **Proposed change**: add `TestClient`-level tests for both routes, mirroring the pattern used
  for the service's other Class-A routes (e.g. `/profile/extract`, `/resume/generate`)
- **Files affected**: `apps/ai-service/tests/test_profiling_turn.py` (extend),
  new `apps/ai-service/tests/test_profiling_extract.py`
- **APIs affected**: none (test-only change) — **DB affected**: none — **CI/CD affected**: runs
  under the existing `pytest` step, no new job needed
- **Risk**: none (additive tests) — **Rollback**: trivial (revert the test file)
- **Verification**: `pytest apps/ai-service/tests/test_profiling_turn.py test_profiling_extract.py`
- **Priority**: P1 — **Dependency**: none — **Complexity**: small

### BL-3 — `guard-contract.test.ts` coverage gap (R37)
- **Category**: Security regression-net gap
- **Problem**: 17 of 62 apps/api controllers aren't imported into the single-source-of-truth
  guard test, including 4 admin controllers. Every guard was individually verified correct in
  code today — this is about catching a *future* regression, not a current vulnerability.
- **Evidence**: [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md) §2 F1,
  [24_RISK_REGISTER.md](24_RISK_REGISTER.md) R37
- **Proposed change**: add the 17 controllers' guard expectations to `guard-contract.test.ts`,
  matching the existing pattern
- **Files affected**: `apps/api/src/common/guard-contract.test.ts`
- **APIs/DB affected**: none (test-only) — **CI/CD affected**: none (existing job)
- **Risk**: none (additive test) — **Rollback**: trivial
- **Verification**: `pnpm --filter @badabhai/api test -- guard-contract`
- **Priority**: P1 — **Dependency**: none, but should be one PR (touches a security-sensitive
  shared test file) with security-engineer or security-reviewer sign-off — **Complexity**: small

### BL-4 — `infra/monitoring/README.md` is stale relative to shipped code
- **Category**: Documentation accuracy
- **Problem**: the README states "No live integration in Phase 1" for Langfuse tracing, but
  `apps/ai-service/app/config.py` and `main.py` already contain real, key-gated Langfuse
  tracing code (dormant only because no keys are set, not because it's unbuilt).
- **Evidence**: [01_SYSTEM_BOUNDARY.md](01_SYSTEM_BOUNDARY.md) §infra/monitoring
- **Proposed change**: update the README to describe the actual state — code wired, dormant
  until keys are configured — rather than "reserved, not built"
- **Files affected**: `infra/monitoring/README.md`
- **Risk**: none (docs-only) — **Verification**: none needed beyond review
- **Priority**: P1 (documentation actively misleads about a privacy-adjacent feature's
  readiness) — **Dependency**: none — **Complexity**: trivial

## P2 — maintainability

### BL-5 — Delete 6 orphaned Flutter widget files
- **Category**: Dead code
- **Evidence**: [06_DEAD_CODE_AUDIT.md](06_DEAD_CODE_AUDIT.md) DC-1
- **Files**: `apps/payer-app/lib/core/widgets/{bb_scaffold,bb_success_stamp,bb_switch_row,bb_tag}.dart`,
  `apps/worker-app/lib/core/widgets/{bb_festive_card,bb_otp_row}.dart`
- **Proposed change**: delete each file + any DS-story/index reference, one PR per app
- **Risk**: low (zero consumers, confirmed by Dart import-graph + no `export` barrel exists)
- **Verification**: `flutter analyze && flutter test` in CI (local verification blocked — Dart
  version mismatch, see [14_TEST_AUDIT.md](14_TEST_AUDIT.md), Batch 2)
- **Priority**: P2 — **Dependency**: mobile-engineer/Rishi sign-off — **Complexity**: trivial

### BL-6 — Consolidate payer-web `/profile` into `/account`
- **Category**: Duplication
- **Evidence**: [07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md) DU-1
- **Proposed change**: shared component or redirect (product decision on which)
- **Files affected**: `apps/payer-web/src/app/(portal)/{profile,account}/page.tsx`
- **Risk**: low — **Verification**: existing `account/page.test.tsx` + a new test for `/profile`'s
  resulting behavior
- **Priority**: P2 — **Dependency**: product decision (keep `/profile` as a distinct URL or
  redirect it) — **Complexity**: small

### BL-7 — Consolidate `WavyText` / `BadaBhaiLogo`'s `wavyChars()`
- **Evidence**: [07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md) DU-2
- **Proposed change**: make `BadaBhaiLogo` compose `WavyText`, or delete `WavyText` if not
  wanted as a general primitive
- **Risk**: low — **Priority**: P2 — **Dependency**: design-engineer call — **Complexity**: trivial

### BL-8 — Add shared `emailSchema`/OTP-digits validator to `@badabhai/validators`
- **Evidence**: [07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md) DU-3
- **Files affected**: `packages/validators/src/index.ts`,
  `apps/{payer-web,admin-web}/src/app/login/actions.ts`
- **Risk**: low — **Priority**: P2 — **Complexity**: small

### BL-9 — Extract `shouldUseSecureCookie()` to a shared location
- **Evidence**: [07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md) DU-4
- **Risk**: low — **Priority**: P2 — **Complexity**: small

### BL-10 — Add a shared ₹ formatter (real cross-app display inconsistency)
- **Evidence**: [07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md) DU-5
- **Problem**: the same pricing catalog currently displays as "₹2,000" in payer-web and
  "₹50000" in apps/web — a real, shipping inconsistency, not just duplicated code
- **Proposed change**: add a formatter export to `packages/pricing` or `@badabhai/config`,
  point all three apps at it
- **Risk**: low (display-only) — **Priority**: P2 (the inconsistency is real and user-visible
  today) — **Complexity**: small

### BL-11, BL-12, BL-13 — ai-service dead-code candidates needing an owner decision
- **Evidence**: [06_DEAD_CODE_AUDIT.md](06_DEAD_CODE_AUDIT.md) DC-3 (`app/corpus/`), DC-4
  (`embed_aliases`/`AliasStore`), DC-5 (legacy profiling contracts, Zod+Pydantic)
- **Proposed change**: none until the named owner decision is made in each case (ADR-0018
  status; PR #214 design-iteration confirmation; Architect sign-off on the contract removal)
- **Priority**: P2 — **Dependency**: as named per item — **Complexity**: small once unblocked

### BL-14 — Resolve the `docs/legal-later` dead reference (R38)
- **Evidence**: [24_RISK_REGISTER.md](24_RISK_REGISTER.md) R38
- **Proposed change**: restore the file or repoint R4/the citing agent doc
- **Priority**: P2 — **Dependency**: Product/Security — **Complexity**: trivial

## P3 — cosmetic / documentation

### BL-15 — Add a `db:score:wedge` package script alias
- **Evidence**: [06_DEAD_CODE_AUDIT.md](06_DEAD_CODE_AUDIT.md) DC-9
- **Priority**: P3 — **Complexity**: trivial

## Decisions needed, not work items (default: KEEP, no code change proposed)

These surfaced during the audit but the audit's own findings recommend **against** action
without a human decision first — listed here so they aren't silently dropped, not as backlog
work:

- **`packages/reach-learn`** (DC-7) — keep; confirm calibration timeline with product/Architect
- **`payerFormDrafts` table** (DC-8) — keep; the code's own comment already asks for an ADR
  decision on whether "a reasonable window" has passed
- **6 unused payer-web DS primitives** (DC-11) — keep; design-engineer call
- **Agent-scoped invite-click route** (DC-12) — keep; confirm QA/demo use with FE
- **DU-6/DU-7 Flutter architectural duplication** (HTTP transport ×3, DS widgets ×2 apps) —
  defer; not worth a shared package for the current 2-consumer count, but log as a trigger for
  when a 3rd Flutter surface appears
- **DU-8/DU-9/DU-10 deliberate duplication** — explicitly do not consolidate; each has a
  documented reason (tracked blockers, differing wire types, differing threat models)

## Summary

| Priority | Count | Theme |
|---|---|---|
| P0 | 0 | — |
| P1 | 4 | Deployment-path gap, ai-service test gap, guard-test gap, stale monitoring doc |
| P2 | 10 | Dead code, duplication consolidation, ai-service dead-code decisions, dead doc link |
| P3 | 1 | Script discoverability |
| Decisions needed | 8 | No code change without a named human sign-off first |
