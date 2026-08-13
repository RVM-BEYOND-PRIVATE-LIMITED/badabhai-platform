# 18 — Project Health Score

No single number is offered here — a manufactured "8.7/10" would hide more than it reveals.
Each dimension gets a qualitative band (**Strong / Good / Partial evidence / Weak / Not
measured in Batch 1**) backed by the specific evidence behind it, per the audit's own
instruction not to fabricate metrics. Percentages appear only where a real count backs them.

## Verification run (2026-08-13, this branch, on `docs/forensic-audit-batch1` @ `44ac03c0` + this batch's doc-only commits)

| Command | Result | Detail |
|---|---|---|
| `pnpm typecheck` | **PASS** | 28/28 packages, exit 0, 14.2s |
| `pnpm lint` | **PASS** | 0 errors, 1 pre-existing warning (`applications.repository.ts:129`, `no-explicit-any`), exit 0 |
| `pnpm build` | **PASS** | 16/16 tasks, exit 0, 34.8s |
| `flutter analyze`/`flutter test` (worker-app, payer-app) | **NOT VERIFIED locally** | local Dart 3.6.2 vs CI pin 3.35.7/Dart 3.9.2 — CI-gated only, per prior project history |
| `pytest` (ai-service) | **NOT RUN this pass** | reviewed via static analysis only; CI's own `ai-service` job (path-filtered) is the live gate |

## Dimension scores

| Dimension | Band | Evidence |
|---|---|---|
| **Architecture integrity** | Good | Clean controller→service→repository layering across all 62 apps/api controllers (verified by direct read); event-first invariant holds (every mutating route emits, confirmed per-route in [03_API_INVENTORY.md](03_API_INVENTORY.md)); pseudonymization gateway is a single enforced choke point (verified in [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md)). **Gap**: 3 of 7 apps (web, payer-web, admin-web) have no evidenced deployment path (BL-1). |
| **API consistency** | Good | 232/232 discovered routes follow a consistent one-principal-per-route pattern (WorkerAuthGuard/PayerAuthGuard/AdminAuthGuard/InternalServiceGuard/SkillsInternalGuard). **Gap**: 17/62 controllers (27%) missing from the guard-contract regression test (R37); ₹ formatting genuinely inconsistent across 3 apps (DU-5). |
| **Business logic isolation** | Strong | Pure, dependency-light packages (`match-engine`, `reach-engine`, `pricing`) structurally enforce "AI never owns business decisions" (CLAUDE.md §3) — no weights/model/I-O in the ranking core. No business logic found inside a controller or repository in the 62 files read. |
| **Test protection** | Good | apps/api: 46/62 controllers (74%) have direct controller-level tests; the other 16 have service/authz/repository-level tests instead — business logic is tested, HTTP-wiring is not, for those 16. ai-service: 13/15 routes (87%) tested; 2 production (Class A) routes have a coverage gap (BL-2). Flutter: CI-gated only, not locally verifiable this pass. |
| **Security posture** | Good | **0 Critical, 0 High** findings in this pass. 2 new Medium/Low process-coverage gaps (R37, R38); 2 new Low/informational items (R39, R40). TD67 re-verified fixed, no regression. Pseudonymization gateway re-verified as a single enforced choke point. Existing register's 2 live-accepted Critical-if-real-calls-on risks (R30, R32) are signed owner rulings, re-verified current, not new. |
| **Database hygiene** | Partial evidence | 65/65 Drizzle-defined tables have `ENABLE ROW LEVEL SECURITY` (100%); `CREATE POLICY` count is 0/65 by design (R1, Data-API lockout via REVOKE, not per-tenant filtering — a known, accepted architecture, not a gap). One table (`payerFormDrafts`) is confirmed unused but self-documents as deliberate forward scaffolding pending an ADR decision. Full schema/migration audit (Phase 8) not done this batch. |
| **Configuration hygiene** | Strong | `packages/config`'s server/public split and `optionalSecret()` pattern correctly fail closed on every secret-shaped field checked; TD67's historical vacuous-arm bug class confirmed closed at the Pydantic layer. |
| **Documentation** | Weak, improving | A 2026-08-05 purge deleted 444 files including all 38 ADRs and `docs/tracker/` (see [17_GIT_HISTORY_AUDIT.md](17_GIT_HISTORY_AUDIT.md)) — the platform currently has **zero ADRs on record** despite pervasive in-code references to them. `docs/architecture/overview.md` contains a dead link to a deleted ADR. This audit batch adds 12 net-new documents covering system boundary, API surface, security, dead-code, and duplication that did not exist platform-wide before. |
| **Deployment reproducibility** | Partial evidence | apps/api and apps/ai-service: fully reproducible (Dockerfile, compose service, CI build-and-push, health-gated deploy order). apps/web, apps/payer-web, apps/admin-web: **no evidenced deployment path** (BL-1). Migrations require manual human application on deploy (a deliberate CD-2 hold, not an oversight). |
| **Dead-code confidence** | Strong (low volume, high discipline) | Only 6 files (0.06% of ~10,127 total files) reached 95–100% delete-confidence; every other candidate was correctly held to a lower confidence band pending a named owner decision rather than over-claimed. This reflects audit discipline as much as codebase cleanliness, but the low absolute volume found is itself evidence the codebase isn't accumulating much true dead weight relative to its 48-day, 610-commit growth rate. |
| **Duplication** | Good | 11 findings; only 5 are genuine/accidental duplication (all small, low-risk, e.g. a copy-pasted validation schema); the other 6 are deliberate and explicitly should NOT be consolidated (documented reasons: tracked blockers, differing wire types, differing threat models). One real, user-visible inconsistency found (₹ formatting, DU-5). |
| **Operational complexity** | Partial evidence | Core request-flow architecture is simple and coherent (5 frontends → 1 API → 1 AI gateway → Postgres/Redis, no separately-deployed worker process). Counter-evidence: 106 local branches / 28 remote / 0 tags (see [BRANCH_BASELINE.md](BRANCH_BASELINE.md)), 3 of 7 apps with no documented deploy path. |
| **Dependency hygiene** | Not measured in Batch 1 | Scoped to `05_DEPENDENCY_AUDIT.md`, Batch 2. |
| **Migration safety** | Not measured in Batch 1 | Scoped to `09_DATABASE_AUDIT.md`, Batch 2. Known from this batch: migrations are NOT auto-applied on deploy (human sign-off required, CD-2 held) — a deliberate control, not yet independently assessed for safety. |
| **CI/CD hygiene** | Not measured in Batch 1 | Scoped to `12_CICD_AUDIT.md`, Batch 2. Known from this batch: 10 workflows exist; the 3 gates re-run in this audit (typecheck/lint/build) are green; individual workflow redundancy/retirement was not assessed. |
| **Observability** | Not measured in Batch 1 | Scoped to `16_OBSERVABILITY_AUDIT.md`, Batch 2. One finding surfaced incidentally: `infra/monitoring/README.md` is stale relative to the actual (dormant, key-gated) Langfuse wiring already present (BL-4). |

## What this batch does NOT support claiming

No overall numeric score, no "X% technical debt closed," no CI/CD health percentage, no
dependency-freshness percentage — none of these were measured with enough rigor this batch to
report responsibly. Batch 2 fills these in.
