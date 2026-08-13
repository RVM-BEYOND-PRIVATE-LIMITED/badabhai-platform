# 18 — Project Health Score

No single number is offered here — a manufactured "8.7/10" would hide more than it reveals.
Each dimension gets a qualitative band (**Strong / Good / Partial evidence / Weak**) backed by
the specific evidence behind it, per the audit's own instruction not to fabricate metrics.
Percentages appear only where a real count backs them. All 16 dimensions are now measured
(Batch 1 measured 12; Batch 2 fills in the remaining 4: dependency hygiene, migration safety,
CI/CD hygiene, observability).

## Verification run (2026-08-13, `docs/forensic-audit-batch1` @ `44ac03c0` + both batches' doc-only commits)

| Command | Result | Detail |
|---|---|---|
| `pnpm typecheck` | **PASS** | 28/28 packages, exit 0, 14.2s |
| `pnpm lint` | **PASS** | 0 errors, 1 pre-existing warning (`applications.repository.ts:129`, `no-explicit-any`), exit 0 |
| `pnpm build` | **PASS** | 16/16 tasks, exit 0, 34.8s |
| `pnpm audit --audit-level high` | **PASS** | 0 vulnerabilities (1 LOW unpatched, `body-parser`, below the gate threshold) |
| `flutter analyze`/`flutter test` (worker-app, payer-app) | **NOT VERIFIED locally** | local Dart 3.6.2 vs CI pin 3.35.7/Dart 3.9.2 — CI-gated only |
| `pytest` (ai-service) | **NOT RUN this pass** | reviewed via static analysis only; CI's own `ai-service` job (path-filtered) is the live gate |

## Dimension scores

| Dimension | Band | Evidence |
|---|---|---|
| **Architecture integrity** | Good | Clean controller→service→repository layering across all 62 apps/api controllers; event-first invariant holds; pseudonymization gateway is a single enforced choke point. Batch 2 confirmed the reachability model is sound but has real sharp edges (11 `@Global()` modules, 1 `APP_INTERCEPTOR` DI-token global, BullMQ producer/consumer connected only by a string constant — [02_CODEBASE_INVENTORY.md](02_CODEBASE_INVENTORY.md) §1). **Gap**: 3 of 7 apps have no evidenced deployment path (BL-1). |
| **API consistency** | Good | 232/232 discovered routes follow a consistent one-principal-per-route pattern. **Gap**: 17/62 controllers (27%) missing from the guard-contract regression test (R38); ₹ formatting genuinely inconsistent across 3 apps (DU-5). |
| **Business logic isolation** | Strong | Confirmed at depth in [08_BUSINESS_LOGIC_MAP.md](08_BUSINESS_LOGIC_MAP.md): every ranking/pricing/unlock-decision path is a pure, deterministic function; the only LLM touch-points are upstream (phrasing, extraction, transcription), never at decision time. No business logic found inside a controller or repository across either batch's reads. |
| **Test protection** | Good, with one significant gap | apps/api: 46/62 controllers (74%) have direct controller-level tests. ai-service: 13/15 routes (87%) tested. Batch 2's deeper pass found **no vacuous tests in an 18-file sample** — genuinely disciplined assertion quality. **But: the Phase-1 worker journey — the platform's core flow — does not execute in CI at all** (5/12 e2e files never run; the one meant to prove it has its test `it.skip`ped — [14_TEST_AUDIT.md](14_TEST_AUDIT.md) §3), and PIN auth has zero integration/E2E coverage despite exceptional unit depth. |
| **Security posture** | Good | **0 Critical, 0 High** findings across both batches. Batch 1: 4 new Medium/Low process gaps (R38-R41). Batch 2 added one **P0** (R42 — a CI workflow's guard doesn't actually prevent running against the production database secret) plus 4 more Medium/Low items (R43-R46, mostly process/coverage gaps, not new attack-surface). TD67 re-verified fixed. Pseudonymization gateway re-verified as a single enforced choke point in both passes. |
| **Database hygiene** | Good | Full 65-table audit ([09_DATABASE_AUDIT.md](09_DATABASE_AUDIT.md)): 694 columns/161 indexes/85 FKs/116 CHECK constraints, all extracted from the authoritative snapshot, not estimated. RLS 65/65 ENABLE'd (100%), re-confirmed independently. PII boundary confirmed to exactly 4 tables. No accidental migration-reversion pattern found across all 74 files. **Gaps**: 4 legacy tables + `payerFormDrafts` confirmed dead/unused (self-documented, deliberate); the Drizzle model only self-documents RLS via `.enableRLS()` on 34/65 tables (a documentation-parity gap, not a security one). |
| **Configuration hygiene** | Strong | `packages/config`'s server/public split and `optionalSecret()` pattern correctly fail closed on every secret-shaped field checked (both batches). Batch 2's full 154-variable enumeration found the pattern applied consistently. **Gap**: 5 production-required secrets have zero documentation line in any `.env.example`, and `apps/admin-web` has no `.env.example` at all (BL-21). |
| **Documentation** | Weak, meaningfully improving | The 2026-08-05 purge deleted 444 files including all 38 ADRs — the platform still has **zero ADRs on record**. Batch 2 independently found 9 operational runbooks cited by path (some with section numbers) across live code and CI that don't exist — confirmed from three separate angles (commands, CI/CD, observability audits), not a single-source claim. This audit adds 24 net-new platform-wide documents covering everything the purge took, though it does not restore the ADRs themselves. |
| **Deployment reproducibility** | Partial evidence | apps/api and apps/ai-service: fully reproducible. apps/web/payer-web/admin-web: no evidenced deployment path (BL-1). Migrations require manual human application (deliberate CD-2 hold). New: the rollback procedure for a bad deploy is reconstructable from compose comments but its own documented runbook doesn't exist (BL-20). |
| **Dead-code confidence** | Strong (low volume, high discipline) | 6 files (0.06% of ~10,127) at 95-100% delete-confidence across the whole audit; every other candidate correctly held to a lower band pending an owner decision. Batch 2 added 4 confirmed-dead-in-application-code DB tables (self-documented as deliberately retained) without changing this picture — still a low absolute volume for a 48-day, 610-commit-old codebase. |
| **Duplication** | Good | 11 findings; 5 genuine/accidental (small, low-risk), 6 deliberate and explicitly not to be consolidated. One real, user-visible inconsistency (₹ formatting, DU-5). Batch 2's database/business-logic passes found the *apparent* duplications there (`jobs`/`job_postings`, three referral tables) are also deliberate, documented migration bridges — not new duplication. |
| **Operational complexity** | Partial evidence | Core request-flow architecture is simple and coherent (5 frontends → 1 API → 1 AI gateway → Postgres/Redis, no separately-deployed worker process — BullMQ processors run in-process). 13 origin branches (all classified — 1 protected, 2 active-PR, 10 safe-to-delete), 108 local-only branches on the audit workstation, 0 tags. 3 of 7 apps with no documented deploy path. |
| **Dependency hygiene** | Good | Full three-toolchain audit ([05_DEPENDENCY_AUDIT.md](05_DEPENDENCY_AUDIT.md)). TS/Node: **0 SUSPECTED_UNUSED** across 96 packages/18 projects, supply-chain policy (`blockExoticSubdeps`, `minimumReleaseAge`, `trustPolicy`) re-verified live and correctly applied, 1 LOW unpatched advisory (`body-parser`, below gate). Python: 0 SUSPECTED_UNUSED but **no lockfile**, no vulnerability scanning, three-way-inconsistent Python version pin (this checkout's venv is one minor ahead of CI/Docker). Flutter: 4 SUSPECTED_UNUSED packages, 1 real cross-app version drift (`firebase_crashlytics`) with unreconciled in-repo commentary. |
| **Migration safety** | Good | 74 migrations, contiguous, journal-verified. Governance confirmed sound: no post-merge edits found, no accidental reversion pattern, every `DROP` traced to one of two deliberate, self-documented patterns (enum-widening or DPDP cascade→set-null). **Known, deliberate gap**: migrations are not auto-applied on deploy to the Lightsail box (CD-2, held for human sign-off) — a control, not an oversight; `staging-cd.yml`/`staging-demand-verify.yml` do apply them automatically, but the latter's secret source is the P0 finding (R42). |
| **CI/CD hygiene** | Good, with one urgent exception | All 10 workflows individually classified — **all KEEP**, no redundant/duplicate lint-test gates found (the repo already consolidated that pattern across #718/#773/#774/#788/#792). Live GitHub-platform state checked, not just YAML: found `supabase-checks.yml` silently `disabled_manually` for a month (F2/R43) and one unpinned tool (`gitleaks:latest`, F5). **`staging-demand-verify.yml`'s live secret topology doesn't match its own "inert by default" framing — the single most significant finding across both audit batches** (F4/R42/BL-16, P0). |
| **Observability** | Partial evidence, one major gap identified | Structured JSON logging on both apps/api and apps/ai-service; a real, globally-wired request/correlation-id middleware on apps/api, threaded correctly through the event stream and BullMQ job payloads. **But the id is never forwarded across the apps/api→apps/ai-service boundary**, and a total ai-service transport failure produces no event at all — the root cause of most "why did this request fail" gaps. Health checks are well-designed and incident-driven (`GET /health`'s multi-check design, the #793 storage-armed-without-credentials gate). No alerting mechanism exists anywhere in the pipeline. |

## What this audit supports claiming, now that both batches are complete

All 16 dimensions have real, evidence-backed bands — no more "Not measured" rows. Still
deliberately not offered: a single overall numeric score (would compress 16 independent
findings into one number that hides which of them matters), a "X% technical debt closed" figure
(nothing has been remediated yet — see [22_REMEDIATION_BACKLOG.md](22_REMEDIATION_BACKLOG.md)),
or a dependency-freshness percentage (version-currency gaps are real but not yet weighted
against each other in a way a single number could responsibly represent).

## The one-sentence summary, if pressed for one

**The codebase is well-architected and disciplined (strong business-logic isolation, low
dead-code volume, no duplicate CI gates, no SUSPECTED_UNUSED TS dependencies) with one urgent
operational-safety gap (BL-16) and a cluster of coverage/observability gaps (the untested core
user journey, the silent CI gate, the unforwarded correlation id, the missing runbooks) that are
individually small but collectively explain why "why did X fail" is hard to answer today.**
