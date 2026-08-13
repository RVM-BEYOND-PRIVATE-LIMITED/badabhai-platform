# 22 — Remediation Backlog

Every actionable item this audit surfaced, prioritized. **P0** = production/security/data
integrity risk, **P1** = architecture/operational risk, **P2** = maintainability, **P3** =
cosmetic/documentation. Nothing here has been actioned — each item still needs its own
individually-reviewed, individually-verified PR per the audit's safe-deletion protocol (see
[23_REMEDIATION_PLAN.md](23_REMEDIATION_PLAN.md)).

**Batch 1 found P0: none.** Batch 2 found one — see BL-16 below, which now anchors this priority
tier.

## P0 — production / security / data integrity risk

### BL-16 — `staging-demand-verify.yml` can run migrations and a synthetic fixture against the production database secret (R42)
- **Category**: CI/CD — production data safety
- **Problem**: this `workflow_dispatch`-only workflow's guard checks only that four secrets are
  non-empty and aren't literally the compose-internal placeholder host — it never checks that
  `DATABASE_URL` is actually a disposable, non-production database. All four required secrets
  are present in the `staging` GH Environment right now, and that Environment's `DATABASE_URL`
  is the **same secret name** `deploy-lightsail` uses to reach the real Postgres backing the
  always-on Lightsail box (`docker-compose.staging.yml`'s own comment: "the real Postgres,
  never the compose-internal one"). The workflow already ran to completion successfully once
  (2026-06-24), applying migrations and writing a synthetic fixture, against credentials still
  live today.
- **Evidence**: [12_CICD_AUDIT.md](12_CICD_AUDIT.md) F4, [24_RISK_REGISTER.md](24_RISK_REGISTER.md) R42
- **Current behavior**: any repository collaborator with `workflow_dispatch` rights can re-run
  this workflow today, and the guard will not stop them
- **Proposed change**: none authored by this audit — this is a secrets/environment
  reconfiguration decision, not a code change this audit can make unilaterally. Two options for
  the owner: (a) provision a genuinely separate disposable database + a separate GH Environment
  before the workflow is ever run again, or (b) add a positive-match guard requiring
  `DATABASE_URL` to contain a disposable-DB marker, failing closed otherwise
- **Files affected**: `.github/workflows/staging-demand-verify.yml` (guard logic), GitHub
  Environment configuration (secret provisioning — outside the repo)
- **APIs/DB affected**: none directly by this backlog item, but the *unfixed* state risks the
  production `DATABASE_URL` — **DB affected: potentially, if re-triggered before fixed**
- **CI/CD affected**: this workflow only
- **Risk**: **high if not fixed before the next manual trigger** — migrations + a synthetic
  fixture write against a real, live-serving database secret; **none from fixing it** (adding a
  positive-match guard or a new environment is additive/restrictive, not behavior-changing for
  legitimate use)
- **Rollback**: N/A — this is a prevention, not a change to revert
- **Verification**: after a fix, confirm the guard rejects a `DATABASE_URL` NOT matching the
  disposable-DB marker, and accepts one that does, via a dry `workflow_dispatch` run
- **Priority**: **P0** — **Dependency**: owner decision on which of the two fix options — GitHub
  Environment/secrets access required, outside this audit's scope — **Complexity**: small once
  the decision is made

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

### BL-3 — `guard-contract.test.ts` coverage gap (R38)
- **Category**: Security regression-net gap
- **Problem**: 17 of 62 apps/api controllers aren't imported into the single-source-of-truth
  guard test, including 4 admin controllers. Every guard was individually verified correct in
  code today — this is about catching a *future* regression, not a current vulnerability.
- **Evidence**: [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md) §2 F1,
  [24_RISK_REGISTER.md](24_RISK_REGISTER.md) R38
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

### BL-17 — Re-enable `supabase-checks.yml` at the GitHub platform level (R43)
- **Category**: CI/CD — silently disabled gate
- **Problem**: this workflow's YAML looks live but is `disabled_manually` at the platform level,
  confirmed via `gh api` — not visible from reading the file. It hasn't run in a month; 31
  migration-touching commits have landed unchecked by either of its two jobs (drift-vs-schema,
  journal-sequence consistency) in that window.
- **Evidence**: [12_CICD_AUDIT.md](12_CICD_AUDIT.md) F2, [24_RISK_REGISTER.md](24_RISK_REGISTER.md) R43
- **Proposed change**: re-enable the workflow (Settings → Actions → Workflows → Enable) — no
  code change
- **Files/APIs/DB affected**: none — **CI/CD affected**: this workflow only
- **Risk**: low to fix (re-enabling a previously-working gate); risk of NOT fixing is continued
  silent coverage loss on schema drift
- **Verification**: confirm the workflow appears and runs on the next `packages/db/**`-touching
  PR
- **Priority**: P1 — **Dependency**: repo-admin access — **Complexity**: trivial

### BL-18 — Rewire the Phase-1 worker-journey e2e suite to the test-login seam (R44)
- **Category**: Test coverage gap — core product flow
- **Problem**: the login→consent→chat→extract→confirm→resume journey has no live execution in
  CI. 5 of 12 `tests/e2e/*.e2e.test.ts` files never run under any committed configuration; the
  one file meant to prove the full journey has its only meaningful test `it.skip`ped.
- **Evidence**: [14_TEST_AUDIT.md](14_TEST_AUDIT.md) §3, [24_RISK_REGISTER.md](24_RISK_REGISTER.md) R44
- **Proposed change**: swap each suite's OTP-login helper for a `POST /auth/test-login` call,
  per the pattern `referral-round-trip.e2e.test.ts` already uses successfully — this is the fix
  `tests/e2e/README.md`'s own TODO already names, not a new design
- **Files affected**: `tests/e2e/{phase1-onboarding,contact-unlock,payer-tenancy,payer-capacity,swipe-to-apply}.e2e.test.ts`
- **Risk**: low (test-only) — but **first resolve the TD129 contradiction** (§3.1 of the test
  audit — does `contact-unlock` actually 500 on `permission denied for table workers` today, or
  has that already been fixed?) via a live CI-log check or local repro, before un-skipping that
  specific suite
- **Verification**: `RUN_E2E=1 TEST_LOGIN_TOKEN=... pnpm --filter @badabhai/e2e test`, confirm
  the journey test passes and asserts every named event
- **Priority**: P1 — **Dependency**: QA sign-off; TD129 resolution for `contact-unlock`
  specifically — **Complexity**: medium (5 files, one of which needs a diagnosis first)

### BL-19 — Thread request/correlation ids through the apps/api → apps/ai-service seam (R45)
- **Category**: Observability gap
- **Problem**: `AiService`'s single HTTP client to ai-service forwards no `x-request-id`/
  `x-correlation-id`, and its failure path (timeout, 401, non-200, network error) produces no
  event — only an untagged log line. This is the root cause of most "why did this ai-service
  call fail" gaps.
- **Evidence**: [16_OBSERVABILITY_AUDIT.md](16_OBSERVABILITY_AUDIT.md) §4, §10,
  [24_RISK_REGISTER.md](24_RISK_REGISTER.md) R45
- **Proposed change**: add the two headers to `AiService`'s `post()` helper (mirrors the
  existing `x-ai-internal-token` pattern) and add ai-service-side middleware to read and log
  them
- **Files affected**: `apps/api/src/ai/ai.service.ts`, `apps/ai-service/app/main.py`
- **Risk**: low (additive headers + logging, no behavior change to success paths)
- **Verification**: a failing ai-service call's log line should carry the same `requestId` the
  originating HTTP request's response body carries
- **Priority**: P1 — **Dependency**: AI Systems Engineer (owns the ai-service side) —
  **Complexity**: small

### BL-20 — Recreate the missing operational runbooks, starting with `docs/rollback-guide.md` (R46)
- **Category**: Documentation — operational readiness
- **Problem**: 9 runbooks are cited by path (some with section numbers) from live code and CI —
  `docs/rollback-guide.md` alone is cited 4 times in `ci.yml`'s currently-executing
  `deploy-lightsail` job — and none exist in the repository. All were deleted in the 2026-08-05
  purge (`eb151468`) and never recreated.
- **Evidence**: [11_COMMAND_REFERENCE.md](11_COMMAND_REFERENCE.md),
  [12_CICD_AUDIT.md](12_CICD_AUDIT.md), [16_OBSERVABILITY_AUDIT.md](16_OBSERVABILITY_AUDIT.md) §9,
  [24_RISK_REGISTER.md](24_RISK_REGISTER.md) R46
- **Proposed change**: recreate at minimum `docs/rollback-guide.md` (the rollback mechanic is
  reconstructable from `docker-compose.staging.yml`'s inline comments); prioritize the others by
  how recently/actively they're cited
- **Files affected**: new `docs/rollback-guide.md` + 8 siblings (see the risk-register row for
  the full path list)
- **Risk**: none (additive documentation)
- **Priority**: P1 (the rollback guide specifically — an active deploy job points at it today) —
  **Dependency**: DevOps — **Complexity**: medium (9 documents, though several are short)

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

### BL-14 — Resolve the `docs/legal-later` dead reference (R39)
- **Evidence**: [24_RISK_REGISTER.md](24_RISK_REGISTER.md) R39
- **Proposed change**: restore the file or repoint R4/the citing agent doc
- **Priority**: P2 — **Dependency**: Product/Security — **Complexity**: trivial

### BL-21 — Document 5 required-in-production secrets missing from every `.env.example`; add one for admin-web
- **Category**: Documentation gap
- **Problem**: `ADMIN_JWT_SECRET`, `PIN_PEPPER`, `SKILLS_INTERNAL_TOKEN`, the api-side
  `AI_INTERNAL_TOKEN`, and `PAYER_LOGIN_METHOD` all carry "MUST override in production"-class
  schema comments but have zero line in any committed template. Separately, `apps/admin-web` has
  **no `.env.example` at all** — an operator provisioning it has nothing to consult for
  `ADMIN_API_BASE_URL`.
- **Evidence**: [10_ENVIRONMENT_AUDIT.md](10_ENVIRONMENT_AUDIT.md) §8, §6
- **Proposed change**: add the 5 missing lines to the root `.env.example` (with the same
  `node -e` generation-snippet pattern `JWT_SECRET`/`PII_HASH_PEPPER` already use); create
  `apps/admin-web/.env.example`
- **Files affected**: `.env.example`, new `apps/admin-web/.env.example`
- **Risk**: none (additive documentation) — **Priority**: P2 — **Complexity**: small

### BL-22 — Add compose-guard coverage for the 25 flags currently unreachable via box-env alone
- **Category**: Configuration/deploy correctness (forward risk, not a live incident)
- **Problem**: none of `PAYMENTS_ENABLE_REAL` and 24 sibling real-provider/feature flags appear
  anywhere in `docker-compose.staging.yml`'s `api:` environment block — the same class of gap
  (`AI_ENABLE_REAL_CALLS` #798, `WORKER_PHOTOS_BUCKET` #794, `ZEPTOMAIL_API_URL` #813,
  `RESUME_RENDER_ENABLED` #793) already fixed four times individually, not yet generalized. All
  five master real-provider flags read `false` today — not a live incident — but the next person
  following this repo's own documented arming pattern for any of the 25 will hit a silent no-op.
- **Evidence**: [10_ENVIRONMENT_AUDIT.md](10_ENVIRONMENT_AUDIT.md) §10
- **Proposed change**: add the missing compose lines (substitution form) for each flag as it's
  next actually needed, following the existing 4 `*-compose.guard.test.ts` pattern; consider a
  single generalized guard test that diffs the full `serverEnvSchema` boolean-flag set against
  the compose block instead of one test per flag
- **Files affected**: `docker-compose.staging.yml`, a new or extended compose-guard test
- **Risk**: low — **Priority**: P2 — **Dependency**: Backend Platform — **Complexity**: medium
  (25 flags, but additive and mechanical)

### BL-23 — `ai.cost_recorded` event drops `success`/`error_code`/`failure_reason`
- **Category**: Observability — event schema gap
- **Problem**: the source `AICallMetadata` carries all three fields; `AiCostRecordedPayload`
  doesn't include any of them — a "spent ₹X successfully" row is indistinguishable from "spent
  ₹X and the call still failed."
- **Evidence**: [16_OBSERVABILITY_AUDIT.md](16_OBSERVABILITY_AUDIT.md) §5
- **Proposed change**: add the three fields to `AiCostRecordedPayload` (additive-only widen —
  matches the event registry's existing precedent for schema changes)
- **Files affected**: `packages/event-schema/src/payloads.ts`,
  `apps/api/src/ai/ai-cost-recorder.service.ts`
- **Risk**: low — **Priority**: P2 — **Dependency**: Chief Architect sign-off (owns
  `packages/event-schema`) — **Complexity**: small

## P3 — cosmetic / documentation

### BL-15 — Add a `db:score:wedge` package script alias
- **Evidence**: [06_DEAD_CODE_AUDIT.md](06_DEAD_CODE_AUDIT.md) DC-9
- **Priority**: P3 — **Complexity**: trivial

### BL-24 — Fix or remove `pnpm dev:all` (invokes a dependency that doesn't exist)
- **Category**: Dev-experience bug (dev-only, no production impact)
- **Problem**: the root `dev:all` script shells out to `concurrently`, which is not declared as
  a dependency anywhere in the workspace or lockfile — fails at runtime for any developer
  without it installed globally.
- **Evidence**: [11_COMMAND_REFERENCE.md](11_COMMAND_REFERENCE.md)
- **Proposed change**: add `concurrently` as a root devDependency, or rewrite the script to use
  `turbo`'s existing parallel-task support instead
- **Priority**: P3 — **Complexity**: trivial

### BL-25 — Pin `gitleaks` to a digest instead of `:latest`
- **Evidence**: [12_CICD_AUDIT.md](12_CICD_AUDIT.md) F5
- **Proposed change**: pin `zricethezav/gitleaks` to a specific digest, matching every other
  action/image in the 10 workflow files
- **Priority**: P3 — **Complexity**: trivial

### BL-26 — Add `.enableRLS()` markers to the 31 Drizzle models missing them
- **Category**: Documentation/drift-detection parity (not a live security gap — RLS is
  genuinely on for all 65 tables at the DB level)
- **Evidence**: [09_DATABASE_AUDIT.md](09_DATABASE_AUDIT.md) §2
- **Proposed change**: add `.enableRLS()` to the 31 table definitions currently missing the
  model-level marker, so `pnpm db:generate`'s diff can itself prove RLS state instead of only a
  migration-grep being able to
- **Priority**: P3 — **Dependency**: Backend Platform — **Complexity**: small, zero-risk
  (metadata-only no-op against an already-RLS'd table)

### BL-27 — Remove or use 4 SUSPECTED_UNUSED Flutter dependencies
- **Evidence**: [05_DEPENDENCY_AUDIT.md](05_DEPENDENCY_AUDIT.md) Part 3
- **Problem**: `cupertino_icons` (both apps, stock scaffold dependency, zero glyph references)
  and `uuid` (payer-app only, self-documented in the pubspec as "for future API binding") have
  zero import hits
- **Priority**: P3 — **Dependency**: mobile-engineer sign-off — **Complexity**: trivial

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
- **`packages/db/src/schema/{profile,questions,profile-questions,worker-answers}` tables**
  (09_DATABASE_AUDIT.md §3.3/§5.5) — confirmed dead in application code, self-documented as
  "superseded, not extended... deliberately not dropped" — candidate for a deprecation ADR once
  `seed-questionnaire.ts` has no dependents either, not a routine cleanup
- **`skill_related` table** (09_DATABASE_AUDIT.md §5.6) — no live application reader (the hot
  path reads a denormalized column instead), but this is deliberate architecture, not orphaning

## Summary

| Priority | Count | Theme |
|---|---|---|
| P0 | 1 | staging-demand-verify.yml's production-DB-secret exposure (BL-16) |
| P1 | 8 | Deployment-path gap, ai-service test gap, guard-test gap, stale monitoring doc, disabled migration-drift gate, Phase-1 e2e journey gap, ai-service correlation-id gap, missing runbooks |
| P2 | 13 | Dead code, duplication consolidation, ai-service dead-code decisions, dead doc link, undocumented required secrets, compose-guard coverage, event-schema gap |
| P3 | 6 | Script discoverability, broken dev script, unpinned gitleaks tag, RLS model-parity markers, unused Flutter deps |
| Decisions needed | 10 | No code change without a named human sign-off first |

**BL-16 (P0) is the one item in this backlog that warrants attention before anything else** —
everything else is either additive (tests, docs, compose lines) or a small, isolated,
individually-revertible change. BL-16 is a live-if-untouched risk to the production database.
