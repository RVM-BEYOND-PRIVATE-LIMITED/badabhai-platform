# 00 — Executive Summary

Forensic codebase audit, Batch 1 of a prioritized, multi-batch program. Read-only investigation
(6 domain-owner agents + direct git/build verification), producing pure documentation — zero
source files, CI workflows, environment variables, migrations, or branches were touched.
Branched `docs/forensic-audit-batch1` from `origin/main @ 44ac03c0`, per this repo's actual
workflow (small feature branches into `main`) rather than the `master`-branch model an initial
audit brief assumed — that branch doesn't exist in this repository. See
[BRANCH_BASELINE.md](BRANCH_BASELINE.md).

## Status block

```text
AUDIT STATUS                 Batch 1 COMPLETE (12 of 24 planned documents).
                              Batch 2 (12 remaining documents) explicitly deferred, not started.
REMEDIATION STATUS            NOT STARTED. 22_REMEDIATION_BACKLOG.md lists 15 actionable items
                              (0 P0, 4 P1, 10 P2, 1 P3) + 8 items requiring a named human
                              decision before any action. Nothing has been implemented.
BRANCH STATUS                 docs/forensic-audit-batch1: 3 commits, docs-only, pushed,
                              PR opened against main, NOT merged.
PRODUCTION SAFETY STATUS      No change made to production code, config, or infrastructure.
                              Verification gates (typecheck/lint/build) re-run clean on this
                              branch — see 18_PROJECT_HEALTH_SCORE.md.
DEVELOPER VERIFICATION STATUS Awaiting human review of this PR. Not yet reviewed.
MAIN STATUS                   NOT TOUCHED.
```

## Application status

```text
Production status:      apps/api + apps/ai-service confirmed actively deployed (Dockerfile,
                         compose service, CI build-and-push, health-gated deploy order).
                         apps/web, apps/payer-web, apps/admin-web: deployment path UNKNOWN
                         from repo evidence (BL-1) — needs a direct answer, not a guess.
                         apps/worker-app, apps/payer-app: CI-gated (analyze+test), no
                         build/store-upload step found in this repo.
Build status:            PASS — pnpm build, 16/16 tasks, exit 0.
Test status:             TypeScript: pnpm typecheck 28/28 PASS. apps/api: 46/62 controllers
                         (74%) have direct controller tests, remainder service-tested.
                         ai-service: 13/15 routes (87%) tested — 2 production routes have a
                         coverage gap (BL-2). Flutter: NOT VERIFIED locally (Dart version
                         mismatch); CI-gated only.
Deployment status:       apps/api/apps/ai-service reproducible; migrations require manual
                         human application (deliberate CD-2 hold).
Database status:         65/65 tables RLS-ENABLE'd; 0/65 have CREATE POLICY (known, accepted
                         architecture — R1 — Data-API lockout, not per-tenant filtering).
CI/CD status:            10 workflows exist; the 3 gates re-run this session are green.
                         Workflow-by-workflow classification deferred to Batch 2.
Security status:         0 Critical, 0 High findings this pass. 2 new Medium/Low
                         process-coverage gaps (R37, R38); 2 new Low/informational (R39, R40).
                         See 15_SECURITY_AUDIT.md.
Observability status:    Not audited this batch beyond one incidental finding (BL-4, stale
                         monitoring doc). Deferred to Batch 2.
Documentation status:    Weak historically (444 files including all 38 ADRs deleted
                         2026-08-05), improving — this batch adds 12 net-new platform-wide
                         documents.
```

## Codebase

```text
Total files:             ~10,127 (excl. node_modules/.next/dist/.venv/build/.dart_tool)
Applications:             7 (apps/api, apps/ai-service, apps/web, apps/payer-web,
                          apps/admin-web, apps/worker-app, apps/payer-app)
Packages:                 12 (packages/*)
Backend modules:          62 controllers in apps/api; 10 routers in apps/ai-service
API routes:                232 (217 apps/api + 15 apps/ai-service), all inventoried
Database tables:           65 (Drizzle-defined), all RLS-enabled
Migrations:                74+ (packages/db/migrations)
CI workflows:               10
Environment variables:     not yet fully enumerated (Batch 2, 10_ENVIRONMENT_AUDIT.md)
Git branches:              106 local, 28 remote (+ 6 on a separate `pr` remote), 0 tags
```

## Technical debt

```text
P0: 0
P1: 4  — deployment-path gap (3 apps), 2 ai-service test-coverage gaps, guard-contract
         test gap (17 controllers), stale monitoring doc
P2: 10 — dead-code owner-decisions, duplication consolidation (5 items), dead doc reference
P3: 1  — script discoverability
```
Full detail: [22_REMEDIATION_BACKLOG.md](22_REMEDIATION_BACKLOG.md).

## Cleanup

```text
Verified dead (95-100% confidence):  6 files (Flutter widgets), 0.06% of total files
Likely dead (80-94% confidence):     4 items — 2 ai-service modules, 1 cross-language
                                      contract pair, 1 unused UI component
Duplicates:                          11 found, 5 genuine/worth consolidating,
                                      6 deliberate/do-not-consolidate
Legacy (deliberate, kept):           4 ops-vs-payer controller pairs (named blockers TD33/TD50)
Unknown (ambiguous, default KEEP):   6 items, each needs a named owner decision
```

## Quality (evidence-backed only)

- typecheck: 28/28 packages PASS
- lint: 0 errors, 1 pre-existing warning
- build: 16/16 tasks PASS
- API inventory completeness: 232/232 discovered routes documented
- No numeric "health score" is offered — see [18_PROJECT_HEALTH_SCORE.md](18_PROJECT_HEALTH_SCORE.md)
  for why, and for the 16-dimension qualitative breakdown.

## CLAUDE_MD_REVIEW_REQUIRED

Per this audit's instruction to flag rather than edit `CLAUDE.md`: it describes a strict
Backend Platform / Frontend Platform two-team split (§5) but does not mention the `.claude/agents/`
domain-owner model this session actually used (system-architect, backend-engineer, ai-engineer,
frontend-engineer, mobile-engineer, security-engineer, etc. — 7 owners + gate agents), and it
does not describe a `master`/`main` branch split (this audit's initial brief assumed one that
doesn't exist in the repo). Neither is a defect in `CLAUDE.md` — both are worth the owner's
attention if the document is next revised, since the current agent-org model and single-`main`
workflow are more specific than what's written. Not edited here per the explicit protection
rule.

---

## What I would not touch

- **The four auth guards and their principals** (`WorkerAuthGuard`, `PayerAuthGuard`,
  `AdminAuthGuard`, `InternalServiceGuard`/`SkillsInternalGuard`) — each independently
  fail-closed, each individually verified in [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md).
- **The pseudonymization gateway** (`apps/ai-service/app/pseudonymize.py`) — the single
  enforced choke point before any LLM call; re-verified with no gap found beyond the two
  already-signed, already-accepted residuals (R30, R32).
- **RLS/REVOKE posture** on all 65 tables — deliberate architecture (R1), not a partial
  implementation to "finish."
- **The 4 deliberately-duplicated ops-vs-payer controller pairs**
  ([07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md#du-8)) — each has a named, tracked reason
  to keep both sides (TD33/TD50); consolidating them would be a regression, not a cleanup.
- **Anything `ACCEPTED AT LAUNCH` in the risk register** (R30, R32) — signed owner rulings,
  re-verified current; changing the underlying behavior requires a new ruling, not a PR.
- **`packages/reach-learn` and the `payerFormDrafts` table** — both self-document as deliberate
  forward scaffolding pending a human/ADR decision, not oversights.
- **Migrations** — never edit historical migration files; the manual-apply deploy gate (CD-2)
  is a deliberate control.

## What can safely be cleaned

**Safe now** (no further verification needed beyond the standard PR gates):
- BL-5: 6 orphaned Flutter widget files (95–100% confidence, zero consumers, isolated)
- BL-4, BL-14, BL-15: three documentation-only fixes

**Safe after verification** (small, low-risk, but touch shared/user-facing surface):
- BL-2, BL-3: test-coverage additions (no behavior change, but review before merge)
- BL-6 through BL-10: the 5 genuine-duplication consolidations (each needs its own small PR
  and, for BL-6, a product decision on redirect-vs-shared-component)

**Needs a named human/product decision before any code change**:
- BL-11, BL-12, BL-13 (ai-service dead-code candidates — ADR-0018 status, PR #214 design
  history, Architect sign-off on a cross-language contract removal)
- The 8 "Decisions needed" items in [22_REMEDIATION_BACKLOG.md](22_REMEDIATION_BACKLOG.md)

**Needs production observation or Batch 2 investigation first**:
- BL-1 (deployment path — needs an answer, not a guess)
- Everything scoped to Batch 2's 12 remaining documents

**Do not touch**: see "What I would not touch" above.

## Batch 2 — not started

`02_CODEBASE_INVENTORY.md`, `05_DEPENDENCY_AUDIT.md`, `08_BUSINESS_LOGIC_MAP.md`,
`09_DATABASE_AUDIT.md`, `10_ENVIRONMENT_AUDIT.md`, `11_COMMAND_REFERENCE.md`,
`12_CICD_AUDIT.md`, `13_GITHUB_BRANCH_AUDIT.md`, `14_TEST_AUDIT.md`,
`16_OBSERVABILITY_AUDIT.md`, `20_MAINTENANCE_MODE_DESIGN.md`, `21_PR_ARCHITECTURE_TRACKING.md`.
Proposed as the next authorization after this batch is reviewed — see
[23_REMEDIATION_PLAN.md](23_REMEDIATION_PLAN.md).
