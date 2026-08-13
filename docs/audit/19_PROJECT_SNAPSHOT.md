# 19 — Project Snapshot

A one-page orientation. Full evidence is linked, not repeated. Both audit batches (24 documents)
are now complete.

## What applications exist?

7 apps in a pnpm-workspaces + Turborepo monorepo: `apps/api` (NestJS backend), `apps/ai-service`
(FastAPI AI gateway), `apps/web` (internal ops console), `apps/payer-web` (external
payer/agency portal), `apps/admin-web` (internal admin portal), `apps/worker-app` (Flutter,
worker mobile), `apps/payer-app` (Flutter, payer/agent mobile). 12 shared packages under
`packages/`. Full detail: [01_SYSTEM_BOUNDARY.md](01_SYSTEM_BOUNDARY.md),
[02_CODEBASE_INVENTORY.md](02_CODEBASE_INVENTORY.md).

## What is currently working?

Everything checked builds, typechecks, and lints clean (see
[18_PROJECT_HEALTH_SCORE.md](18_PROJECT_HEALTH_SCORE.md)'s verification run — now including a
clean `pnpm audit`). apps/api and apps/ai-service are confirmed actively deployed and, per
[12_CICD_AUDIT.md](12_CICD_AUDIT.md), the deploy pipeline itself is verified live (the last 8
pushes to `main` all completed `deploy-lightsail` successfully). 232 API routes are inventoried,
each with a confirmed auth guard and a confirmed caller or an explicit "built ahead of its UI"
note. The deterministic business core (matching, pricing, unlocks, the profiling interview
engine) is confirmed pure and AI-decision-free end to end — see
[08_BUSINESS_LOGIC_MAP.md](08_BUSINESS_LOGIC_MAP.md).

## What is production-critical?

The four auth principals (worker OTP+PIN, payer OTP, admin JWT+MFA, internal service token),
the pseudonymization gateway (single enforced choke point before any LLM call), RLS/REVOKE
posture on all 65 tables, every Class-A route in [03_API_INVENTORY.md](03_API_INVENTORY.md),
and the deterministic core packages (`match-engine`, `reach-engine`, `pricing`). See "What I
would not touch" in [00_EXECUTIVE_SUMMARY.md](00_EXECUTIVE_SUMMARY.md).

## What is being actively developed?

Worker-app's `voice_form` sub-feature (touched 2026-08-13, commit `1438477d`) — built, tested,
not yet wired into navigation, behind a documented remote-config kill switch; in-flight work,
not dead code ([06_DEAD_CODE_AUDIT.md](06_DEAD_CODE_AUDIT.md)). `staging-cd.yml` was itself
manually triggered for the first time on audit day and correctly no-op'd (verified inert) —
active platform-provisioning work in progress for a persistent staging host distinct from the
Lightsail box ([12_CICD_AUDIT.md](12_CICD_AUDIT.md) F3).

## What is deprecated?

4 ops-console controller pairs in apps/api are explicitly `@deprecated` in favor of their
payer-session-scoped siblings, kept alive by two named, tracked blockers (TD33/TD50) — see
[07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md#du-8). `packages/reach-learn` is deliberately
dormant, awaiting a human-gated promotion decision. 4 legacy questionnaire DB tables are
confirmed dead in application code but deliberately retained pending an ADR
([09_DATABASE_AUDIT.md](09_DATABASE_AUDIT.md) §3.3).

## What is risky?

**One item needs attention before anything else**: a CI workflow (`staging-demand-verify.yml`)
shares the production database secret and its guard doesn't actually stop a re-run against it —
already ran once, could run again today ([12_CICD_AUDIT.md](12_CICD_AUDIT.md) F4,
[24_RISK_REGISTER.md](24_RISK_REGISTER.md) R41). Everything else found is Medium or lower: a
CI gate silently disabled at the platform level for a month (R42), the platform's core user
journey not executing in CI (R43), an unforwarded correlation id across the AI service boundary
that makes incident response harder than it needs to be (R44), and 9 operational runbooks cited
by live code that don't exist (R45). No Critical or High security finding across either batch —
full detail: [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md), [24_RISK_REGISTER.md](24_RISK_REGISTER.md).

## What is broken?

Nothing in the shipped codebase. Two things are broken in tooling/process: `pnpm dev:all`
invokes a dependency (`concurrently`) that isn't installed anywhere in the workspace
([11_COMMAND_REFERENCE.md](11_COMMAND_REFERENCE.md)), and the migration-drift CI gate has been
silently off for a month (above).

## What is duplicated?

11 code/UI-level instances found across Batch 1 (5 accidental/worth consolidating, 6
deliberate/do-not-consolidate — [07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md)). Batch 2's
database and business-logic passes found the *apparent* duplications there — `jobs`/
`job_postings`, three separate referral-attribution tables — are also deliberate, documented
migration bridges, not accidental duplication. The one real, currently-shipping user-facing bug
remains: the same pricing catalog displays with digit grouping in payer-web ("₹2,000") and
without it in apps/web ("₹50000").

## What is unverified?

Flutter (`worker-app`, `payer-app`) — cannot run `flutter analyze`/`flutter test` or
`flutter pub get` locally (Dart/Flutter version mismatch); CI-gated only, and CI-execution
claims in this audit are derived from reading gate code, not from a live run. `apps/ai-service`'s
pytest suite reviewed statically, not executed. Whether `referral-round-trip.e2e.test.ts` is
actually green in current CI given a contradiction with a documented prior defect (TD129) —
needs a live CI-log check ([14_TEST_AUDIT.md](14_TEST_AUDIT.md) §3.1). Who disabled
`supabase-checks.yml` and why — no PR/issue references it ([12_CICD_AUDIT.md](12_CICD_AUDIT.md) F2).

## What should NOT be touched?

See "What I would not touch" in [00_EXECUTIVE_SUMMARY.md](00_EXECUTIVE_SUMMARY.md) — the short
version: the four auth guards, the pseudonymization gateway, RLS/REVOKE posture, the
deterministic business-logic core, the 4 deliberately-duplicated ops-vs-payer controller pairs,
and anything currently `ACCEPTED AT LAUNCH` in the risk register (R30, R32).

## What is the next priority?

Per [23_REMEDIATION_PLAN.md](23_REMEDIATION_PLAN.md)'s suggested execution order: (1) resolve
BL-16 (the P0 production-database-secret exposure) first, (2) re-enable `supabase-checks.yml`
(one click), (3) the 6-file Flutter dead-code removal, (4) the test-coverage and observability
additions (BL-2/BL-3/BL-19), (5) documentation fixes, (6) the Phase-1 e2e journey rewiring, then
(7) the Stage D duplication consolidations. No further audit batch is planned — remaining work
is remediation, gated on explicit authorization per item.

## Evidence-based coverage metrics

| Metric | Value | Basis |
|---|---|---|
| API routes documented | 232 / 232 found | Every controller/router read in full |
| apps/api controller-level test coverage | 46 / 62 (74%) | Direct file check; remaining 16 have service/authz/repository tests instead |
| ai-service route test coverage | 13 / 15 (87%) | Direct file check |
| guard-contract.test.ts controller coverage | 45 / 62 (73%) | Direct diff against the test's import list |
| RLS-enabled tables | 65 / 65 (100%) | Migration-file grep, independently re-derived twice |
| RLS self-documented at the Drizzle-model level | 34 / 65 (52%) | The other 31 are RLS'd via migration only — a documentation-parity gap, not a security one |
| Dead-code candidates at ≥95% confidence | 6 files / ~10,127 total (0.06%) | See [06_DEAD_CODE_AUDIT.md](06_DEAD_CODE_AUDIT.md) |
| TS/Node dependencies SUSPECTED_UNUSED | 0 / 96 packages | See [05_DEPENDENCY_AUDIT.md](05_DEPENDENCY_AUDIT.md) Part 1 |
| CI/CD workflows classified | 10 / 10, all KEEP | See [12_CICD_AUDIT.md](12_CICD_AUDIT.md) |
| origin branches classified | 13 / 13 (10 safe-to-delete, verified merged-PR provenance) | See [13_GITHUB_BRANCH_AUDIT.md](13_GITHUB_BRANCH_AUDIT.md) |
| `tests/e2e/` files actually executing in CI | 6 / 12 | See [14_TEST_AUDIT.md](14_TEST_AUDIT.md) §3 |
| Verification gates passing | 4 / 4 (typecheck, lint, build, pnpm audit) | Commands re-run this session, see [18_PROJECT_HEALTH_SCORE.md](18_PROJECT_HEALTH_SCORE.md) |
| Audit deliverables shipped | **24 / 24 planned** | This document set, both batches |
