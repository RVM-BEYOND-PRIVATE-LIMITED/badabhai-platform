# 19 — Project Snapshot

A one-page orientation. Full evidence is linked, not repeated.

## What applications exist?

7 apps in a pnpm-workspaces + Turborepo monorepo: `apps/api` (NestJS backend), `apps/ai-service`
(FastAPI AI gateway), `apps/web` (internal ops console), `apps/payer-web` (external
payer/agency portal), `apps/admin-web` (internal admin portal), `apps/worker-app` (Flutter,
worker mobile), `apps/payer-app` (Flutter, payer/agent mobile). 12 shared packages under
`packages/`. Full detail: [01_SYSTEM_BOUNDARY.md](01_SYSTEM_BOUNDARY.md).

## What is currently working?

Everything checked in this batch builds, typechecks, and lints clean (see
[18_PROJECT_HEALTH_SCORE.md](18_PROJECT_HEALTH_SCORE.md)'s verification run). apps/api and
apps/ai-service are confirmed actively deployed (Dockerfile + compose service + CI
build-and-push + health-gated deploy order to a persistent Lightsail box). 232 API routes are
inventoried, each with a confirmed auth guard and, for 215 of them, a confirmed frontend/mobile
or internal caller.

## What is production-critical?

The four auth principals (worker OTP+PIN, payer OTP, admin JWT+MFA, internal service token),
the pseudonymization gateway (single enforced choke point before any LLM call), RLS/REVOKE
posture on all 65 tables, and every Class-A route in
[03_API_INVENTORY.md](03_API_INVENTORY.md). See "What I would not touch" in
[00_EXECUTIVE_SUMMARY.md](00_EXECUTIVE_SUMMARY.md).

## What is being actively developed?

Worker-app's `voice_form` sub-feature (touched today, 2026-08-13, commit `1438477d`) — built,
tested, but not yet wired into navigation, behind a documented remote-config kill switch. See
[06_DEAD_CODE_AUDIT.md](06_DEAD_CODE_AUDIT.md)'s "checked and ruled out" section — this is
in-flight work, not dead code.

## What is deprecated?

4 ops-console controller pairs in apps/api are explicitly `@deprecated`/marked
"MUST NEVER be network-exposed to payers" in favor of their payer-session-scoped siblings, kept
alive by two named, tracked blockers (TD33/TD50) — see
[07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md#du-8). `packages/reach-learn` is deliberately
dormant, awaiting a human-gated promotion decision.

## What is risky?

Nothing Critical or High found this batch. Two Medium findings worth near-term attention: the
`guard-contract.test.ts` regression-net gap covering 27% of apps/api controllers (R37), and the
apps/web/payer-web/admin-web deployment-path gap (BL-1) — not a known vulnerability, but an
unanswered "where does this actually run?" question. Full list:
[15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md), [24_RISK_REGISTER.md](24_RISK_REGISTER.md).

## What is broken?

Nothing found broken. All three verification gates (typecheck, lint, build) pass clean on this
branch.

## What is duplicated?

11 instances found; only 5 are accidental/worth consolidating (all small — a validation schema,
a cookie helper, a currency formatter, a UI page, a component). One is a real, currently-
shipping user-facing bug: the same pricing catalog displays with digit grouping in payer-web
("₹2,000") and without it in apps/web ("₹50000"). Full list:
[07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md).

## What is unverified?

Flutter (`worker-app`, `payer-app`) — cannot run `flutter analyze`/`flutter test` locally (Dart
version mismatch); CI-gated only. `apps/ai-service`'s pytest suite was reviewed statically, not
executed, this pass. 12 of the source audit's 24 planned documents (dependency, database, CI/CD,
branch-by-branch, test-coverage-map, observability, environment, commands, maintenance-mode,
PR-tracking audits) — see Batch 2 list in [23_REMEDIATION_PLAN.md](23_REMEDIATION_PLAN.md).

## What should NOT be touched?

See "What I would not touch" in [00_EXECUTIVE_SUMMARY.md](00_EXECUTIVE_SUMMARY.md) — the short
version: the four auth guards, the pseudonymization gateway, RLS/REVOKE posture, the 4
deliberately-duplicated ops-vs-payer controller pairs, and anything currently
`ACCEPTED AT LAUNCH` in the risk register (R30, R32).

## What is the next priority?

Per [23_REMEDIATION_PLAN.md](23_REMEDIATION_PLAN.md): (1) the 6-file Flutter dead-code removal
(smallest, safest, fully evidence-backed), (2) the two ai-service test-coverage gaps (pure
additions), (3) the documentation fixes (BL-4, BL-14, BL-15), then (4) Batch 2's remaining 12
documents, pending review of this batch.

## Evidence-based coverage metrics

| Metric | Value | Basis |
|---|---|---|
| API routes documented | 232 / 232 found | Every controller/router read in full |
| apps/api controller-level test coverage | 46 / 62 (74%) | Direct file check; remaining 16 have service/authz/repository tests instead |
| ai-service route test coverage | 13 / 15 (87%) | Direct file check |
| guard-contract.test.ts controller coverage | 45 / 62 (73%) | Direct diff against the test's import list |
| RLS-enabled tables | 65 / 65 (100%) | Migration-file grep |
| Dead-code candidates at ≥95% confidence | 6 files / ~10,127 total (0.06%) | See [06_DEAD_CODE_AUDIT.md](06_DEAD_CODE_AUDIT.md) |
| Verification gates passing | 3 / 3 (typecheck, lint, build) | Commands run this session, see [18_PROJECT_HEALTH_SCORE.md](18_PROJECT_HEALTH_SCORE.md) |
| Audit deliverables shipped this batch | 12 / 24 planned | This document set |
