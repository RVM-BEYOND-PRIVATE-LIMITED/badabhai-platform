# 00 — Executive Summary

Forensic codebase audit — **both planned batches now complete (24 of 24 documents)**. Read-only
investigation (19 domain-owner agent dispatches total across both batches, plus direct
git/build/CI-platform verification), producing pure documentation — zero source files, CI
workflows, environment variables, migrations, or branches were touched. Batch 1 branched
`docs/forensic-audit-batch1` from `origin/main @ 44ac03c0`; Batch 2 branched
`docs/forensic-audit-batch2` from the same commit and merged Batch 1's (still-unmerged) branch
in so its documents' cross-references resolve — both follow this repo's actual workflow (small
feature branches into `main`) rather than the `master`-branch model an initial audit brief
assumed, since that branch doesn't exist in this repository. See
[BRANCH_BASELINE.md](BRANCH_BASELINE.md).

## Status block

```text
AUDIT STATUS                 COMPLETE — 24 of 24 planned documents shipped across two batches.
REMEDIATION STATUS            NOT STARTED. 22_REMEDIATION_BACKLOG.md lists 27 actionable items
                              (1 P0, 8 P1, 13 P2, 6 P3) + 10 items requiring a named human
                              decision before any action. Nothing has been implemented.
BRANCH STATUS                 docs/forensic-audit-batch1: 3 commits, PR #821 open, NOT merged.
                              docs/forensic-audit-batch2: 5 commits + a merge of batch1's
                              branch, pushed, PR opened against main, NOT merged. Batch 2's PR
                              diff currently includes Batch 1's content too, since #821 hasn't
                              landed — rebase Batch 2 onto main after #821 merges to shrink the
                              diff to Batch 2's own changes.
PRODUCTION SAFETY STATUS      No change made to production code, config, or infrastructure on
                              either branch. Verification gates (typecheck/lint/build) re-run
                              clean — see 18_PROJECT_HEALTH_SCORE.md.
DEVELOPER VERIFICATION STATUS Awaiting human review of both PRs. Not yet reviewed.
MAIN STATUS                   NOT TOUCHED.
```

**One finding needs attention before anything else in this document**: [BL-16](22_REMEDIATION_BACKLOG.md)
(P0) — `staging-demand-verify.yml` shares the production `DATABASE_URL` secret and has already
run once; the guard that's supposed to prevent a re-run against live data doesn't actually check
for a disposable database. See [12_CICD_AUDIT.md](12_CICD_AUDIT.md) F4 and
[24_RISK_REGISTER.md](24_RISK_REGISTER.md) R42.

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
                         mismatch); CI-gated only. **The Phase-1 worker journey — this
                         platform's core flow — does not execute in CI at all** (BL-18/R44).
Deployment status:       apps/api/apps/ai-service reproducible; migrations require manual
                         human application (deliberate CD-2 hold). Rollback runbook cited by
                         a live deploy job does not exist in the repo (BL-20/R46).
Database status:         65/65 tables RLS-ENABLE'd; 0/65 have CREATE POLICY (known, accepted
                         architecture — R1 — Data-API lockout, not per-tenant filtering).
                         4 legacy tables confirmed dead in application code (self-documented,
                         deliberately retained, not a cleanup target without an ADR).
CI/CD status:            10 workflows, all classified KEEP — but one (supabase-checks.yml) is
                         silently disabled at the platform level for a month (BL-17/R43), and
                         one (staging-demand-verify.yml) is the P0 finding above (BL-16/R42).
Security status:         0 Critical, 0 High findings across both batches. 4 new Medium/Low
                         process-coverage gaps from Batch 1 (R38-R41); Batch 2 added the P0
                         (R42) plus 4 more Medium items (R43-R46, mostly CI/observability
                         process gaps, not new attack-surface findings).
Observability status:    The single HTTP client between apps/api and apps/ai-service forwards
                         no correlation id and produces no event on transport failure — the
                         root cause of most "why did this request fail" gaps (BL-19/R45). No
                         alerting mechanism exists anywhere in the pipeline.
Documentation status:    Weak historically (444 files including all 38 ADRs deleted
                         2026-08-05), improving — this audit adds 24 net-new platform-wide
                         documents. 9 operational runbooks are still cited by live code/CI but
                         don't exist (BL-20/R46).
```

## Codebase

```text
Total files:             ~10,127 (excl. node_modules/.next/dist/.venv/build/.dart_tool)
Applications:             7 (apps/api, apps/ai-service, apps/web, apps/payer-web,
                          apps/admin-web, apps/worker-app, apps/payer-app)
Packages:                 12 (packages/*)
Backend modules:          62 controllers/88 services/48 repositories in apps/api;
                          10 routers in apps/ai-service (single static registration point)
API routes:                232 (217 apps/api + 15 apps/ai-service), all inventoried
Database tables:           65 (Drizzle-defined), 694 columns, 161 indexes, 85 FKs,
                          all RLS-enabled, 0 CREATE POLICY (by design)
Migrations:                74 (0000-0073, contiguous, journal-verified)
CI workflows:               10 (all KEEP-classified; 2 flagged for platform-level action)
Environment variables:     154 server-side + 3 public (apps/api); ~70 separate Pydantic
                          vars (apps/ai-service); own local schemas per web app
Git branches (origin):      13 (1 protected, 2 active-PR, 10 verified safe-to-delete);
                          108 local-only on the auditing workstation, not classified
Dependencies:              96 TS/Node packages across 18 pnpm projects (0 SUSPECTED_UNUSED,
                          1 LOW advisory); ai-service Python (0 SUSPECTED_UNUSED, no
                          lockfile); 2 Flutter apps (4 SUSPECTED_UNUSED, 1 real version drift)
```

## Technical debt

```text
P0: 1  — staging-demand-verify.yml's production-DB-secret exposure (BL-16)
P1: 8  — deployment-path gap, 2 test-coverage gaps, guard-test gap, stale monitoring doc,
         disabled migration-drift gate, Phase-1 e2e journey gap, ai-service correlation-id
         gap, missing runbooks
P2: 13 — dead-code owner-decisions, duplication consolidation, undocumented secrets,
         compose-guard coverage, event-schema gap
P3: 6  — script discoverability, broken dev script, unpinned CI tool, RLS model-parity,
         unused Flutter deps
```
Full detail: [22_REMEDIATION_BACKLOG.md](22_REMEDIATION_BACKLOG.md).

## Cleanup

```text
Verified dead (95-100% confidence):  6 files (Flutter widgets), 0.06% of total files
Likely dead (80-94% confidence):     4 items — 2 ai-service modules, 1 cross-language
                                      contract pair, 1 unused UI component
Confirmed dead, deliberately kept:   4 legacy DB tables (application-code-dead, self-flagged
                                      as intentionally retained pending an ADR)
Duplicates:                          11 found, 5 genuine/worth consolidating,
                                      6 deliberate/do-not-consolidate
Legacy (deliberate, kept):           4 ops-vs-payer controller pairs (named blockers TD33/TD50)
Unknown (ambiguous, default KEEP):   10 items, each needs a named owner decision
```

## Quality (evidence-backed only)

- typecheck: 28/28 packages PASS
- lint: 0 errors, 1 pre-existing warning
- build: 16/16 tasks PASS
- API inventory completeness: 232/232 discovered routes documented
- `pnpm audit`: 0 vulnerabilities at the `high` gate threshold; 1 LOW (`body-parser`, unpatched, non-blocking)
- No numeric "health score" is offered — see [18_PROJECT_HEALTH_SCORE.md](18_PROJECT_HEALTH_SCORE.md)
  for why, and for the dimension-by-dimension qualitative breakdown.

## CLAUDE_MD_REVIEW_REQUIRED

Per this audit's instruction to flag rather than edit `CLAUDE.md`: it describes a strict Backend
Platform / Frontend Platform two-team split (§5) but does not mention the `.claude/agents/`
domain-owner model this session actually used (system-architect, backend-engineer, ai-engineer,
frontend-engineer, mobile-engineer, security-engineer, devops-engineer, qa-engineer,
database-architect, etc.), and it does not describe a `master`/`main` branch split (this audit's
initial brief assumed one that doesn't exist in the repo). Neither is a defect in `CLAUDE.md` —
both are worth the owner's attention if the document is next revised, since the current
agent-org model and single-`main` workflow are more specific than what's written. Not edited
here per the explicit protection rule.

---

## What I would not touch

- **The four auth guards and their principals** (`WorkerAuthGuard`, `PayerAuthGuard`,
  `AdminAuthGuard`, `InternalServiceGuard`/`SkillsInternalGuard`) — each independently
  fail-closed, each individually verified in [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md).
- **The pseudonymization gateway** (`apps/ai-service/app/pseudonymize.py`) — the single
  enforced choke point before any LLM call; re-verified with no gap found beyond the two
  already-signed, already-accepted residuals (R30, R32).
- **RLS/REVOKE posture** on all 65 tables — deliberate architecture (R1), not a partial
  implementation to "finish." (The RLS-model documentation-parity gap, BL-26, is cosmetic —
  RLS itself is unaffected.)
- **The deterministic business-logic core** — `packages/match-engine`, `packages/reach-engine`,
  `packages/pricing`, and the profiling interview's `next-question.ts`/`predicate.ts` — pure,
  zero-I/O, CEO/owner-ratified thresholds (e.g. `tierFloorMonths`). Changing a ratified
  threshold is a business decision requiring the same ratification path, not a PR
  ([08_BUSINESS_LOGIC_MAP.md](08_BUSINESS_LOGIC_MAP.md) §5.3).
- **The 4 deliberately-duplicated ops-vs-payer controller pairs**
  ([07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md#du-8)) — each has a named, tracked reason
  to keep both sides (TD33/TD50); consolidating them would be a regression, not a cleanup.
- **Anything `ACCEPTED AT LAUNCH` in the risk register** (R30, R32) — signed owner rulings,
  re-verified current; changing the underlying behavior requires a new ruling, not a PR.
- **`packages/reach-learn`, the `payerFormDrafts` table, and the 4 dead legacy questionnaire
  tables** — all self-document as deliberate forward-or-backward scaffolding pending a
  human/ADR decision, not oversights.
- **Migrations** — never edit historical migration files; the manual-apply deploy gate (CD-2)
  is a deliberate control. No migration reverts a prior migration by apparent mistake
  ([09_DATABASE_AUDIT.md](09_DATABASE_AUDIT.md) §5.9, §6).
- **`staging-demand-verify.yml`'s underlying purpose** (proving the demand loop end-to-end) —
  the workflow's *intent* is real and useful; only its *secret source* needs to change (BL-16).

## What can safely be cleaned

**Safe now** (no further verification needed beyond the standard PR gates):
- BL-5: 6 orphaned Flutter widget files (95–100% confidence, zero consumers, isolated)
- BL-4, BL-14, BL-15, BL-24, BL-25: five small documentation/config fixes

**Safe after verification** (small, low-risk, but touch shared/user-facing surface):
- BL-2, BL-3, BL-19: test-coverage and observability additions (no behavior change, but review
  before merge)
- BL-6 through BL-10: the 5 genuine-duplication consolidations (each needs its own small PR
  and, for BL-6, a product decision on redirect-vs-shared-component)
- BL-17: re-enable `supabase-checks.yml` (platform setting, not code — but verify it actually
  runs clean against the current migration chain before treating it as fully restored)
- BL-21, BL-26, BL-27: documentation and dependency-hygiene additions

**Needs a named human/product decision before any code change**:
- BL-11, BL-12, BL-13 (ai-service dead-code candidates — ADR-0018 status, PR #214 design
  history, Architect sign-off on a cross-language contract removal)
- BL-23 (event-schema widen — Chief Architect sign-off, owns `packages/event-schema`)
- The 10 "Decisions needed" items in [22_REMEDIATION_BACKLOG.md](22_REMEDIATION_BACKLOG.md)

**Needs urgent owner action, not routine cleanup**:
- **BL-16 (P0)** — resolve before any other remediation work; see the callout at the top of
  this document

**Needs production observation or further investigation first**:
- BL-1 (deployment path — needs an answer, not a guess)
- BL-18 (Phase-1 e2e journey rewiring — the TD129 contradiction for `contact-unlock`
  specifically needs a live CI-log check or local repro before that one suite is touched)
- Stage G's 10 `SAFE_TO_DELETE` branches ([13_GITHUB_BRANCH_AUDIT.md](13_GITHUB_BRANCH_AUDIT.md))
  — classified with verified merged-PR provenance, but deletion itself needs explicit human
  authorization per the audit's protocol

**Do not touch**: see "What I would not touch" above.

## Audit history

Batch 1 (2026-08-13): system boundary, API inventory, route map, dead-code audit, duplication
audit, security audit, risk-register reconciliation, remediation backlog/plan, git-history
audit, health score, project snapshot, executive summary — 12 documents.

Batch 2 (2026-08-13): codebase inventory, dependency audit (3 toolchains), business logic map,
database audit + relationship diagram, environment audit, command reference, CI/CD audit,
GitHub branch audit, test audit, observability audit, maintenance-mode design, PR
architecture-tracking checklist — 12 documents. Synthesis documents (this one, plus
[18](18_PROJECT_HEALTH_SCORE.md), [19](19_PROJECT_SNAPSHOT.md),
[22](22_REMEDIATION_BACKLOG.md), [23](23_REMEDIATION_PLAN.md), [24](24_RISK_REGISTER.md)) were
updated in place to incorporate both batches rather than duplicated per batch.

**No Batch 3 is currently planned.** Everything the original 24-document request asked for has
been produced. Next steps are remediation (starting with BL-16), not further audit — see
[23_REMEDIATION_PLAN.md](23_REMEDIATION_PLAN.md)'s suggested execution order.
