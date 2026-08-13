# 14 — Test Audit

**Method.** Batch 1 already measured raw test-file-presence (apps/api: 46/62 controllers with a direct test; apps/ai-service: 13/15 routes tested, gaps on `/profiling/turn`/`/profiling/extract`) — not re-derived here. This document goes one layer deeper: for a representative sample of test files, it assesses whether assertions exercise real behavior or are vacuous, and it audits the root `tests/e2e/` suite file-by-file for what actually *executes* in CI today versus what is written but gated off. No test suite was executed by this audit pass — CI-execution claims are derived from reading skip-gate code against `ci.yml`'s literal env values, not a live run; flagged as such where it matters.

## 1. Test landscape

| Layer | Location | Framework | File count |
|---|---|---|---|
| apps/api unit/service/controller/authz/repository | co-located `*.test.ts` | Vitest | 293 files, ~3,979 `it(...)` cases |
| apps/ai-service unit/router/eval | `apps/ai-service/tests/test_*.py` | pytest | 56 files |
| apps/web | co-located | Vitest | 7 files |
| apps/payer-web | co-located | Vitest + Testing Library | 85 files |
| apps/admin-web | co-located | Vitest | 9 files |
| apps/worker-app | `test/**` (+ `test/e2e/app_journey_test.dart`) | `flutter test` | 143 files |
| apps/payer-app | `test/**` | `flutter test` | 36 files |
| packages/* | co-located | Vitest | 58 files |
| Cross-cutting E2E | `tests/e2e/*.e2e.test.ts` | Vitest, opt-in `RUN_E2E=1` | 12 files |
| Cross-cutting contract | `tests/contract/` | — | **scaffolding only — 0 test files, README only** |
| Cross-cutting security | `tests/security/` | — | **scaffolding only — 0 test files, README only** |

`tests/README.md` documents the intended split: co-located tests own per-package/app behavior, `tests/{contract,e2e,security}/` own cross-cutting proof. Two of three are empty scaffolding, dated to Phase-1 and unfilled since. `tests/contract/` would keep the TS/Zod↔Python/Pydantic seam honest — today the only contract-parity coverage is `apps/ai-service/tests/test_contract_parity.py`, co-located under ai-service rather than cross-cutting. `tests/security/` would hold cross-service "no PII in events/logs, pseudonymization fail-closed" assertions — today these exist only as scattered per-service assertions inside individual unit tests, not a single owned suite.

## 2. Real vs vacuous — 18 files sampled in full

**No genuinely vacuous test was found in this sample.** A targeted grep for common vacuous markers (`expect(true).toBe(true)`, a bare `.toHaveBeenCalled()` as the *only* assertion, `toMatchSnapshot()`) found **zero** snapshot tests anywhere in the repo and no bare "mock was called" test with no outcome assertion in the files sampled.

Highlights (all "Real," several exceptional): `guard-contract.test.ts` (reads actual `@UseGuards` Reflect metadata and asserts guard set + order — a genuine regression net; known gap: 17/62 controllers not enrolled, Batch 1 F1); `otp.service.test.ts` (drives a real state machine over an in-memory Redis double — hourly/daily/global caps, HMAC-not-plaintext, fail-closed on Redis error); `pin.service.test.ts` (906 lines — exponential lockout ladder, multi-device race, force-OTP durability across a simulated Redis flush, byte-identical no-oracle across 6 negative paths, full PII-leaf scan); `admin-pii-reveal.service.test.ts` (proves audit-BEFORE-decrypt ordering, fail-closed on a failed audit emit, no-oracle, recursive log/event leaf scan — matches R24's "single most sensitive route" status); `razorpay-raw-body.integration.test.ts` (boots an actual NestJS app and makes real HTTP requests to prove byte-exact raw-body capture — a second-order property a unit test with a fake stream couldn't prove); `unlocks.service.test.ts` (750 lines mirroring the F-1…F-6 invariants byte-for-byte); `test_pseudonymize.py` (782 lines/46 functions, property-based, and — notably — **pins the known residual gaps as failing-boundary proofs**, i.e. R2/R30/R32's gap is asserted to still exist rather than silently left untested); `test_service_auth.py` (enumerates the actually-served route tree, not the OpenAPI-documented one, and asserts every route 401s tokenless); `parked-modules.test.tsx` (payer-web — tests a *negative* requirement: no interactive control renders, no commercial term is promised for a deliberately-unbuilt feature).

## 3. `tests/e2e/` — what actually executes in CI today

**The most consequential finding in this document.** `tests/e2e/`'s README states the intent squarely: "login (mock OTP) → consent → chat → profile extract (async) → confirm → resume generate — asserting the expected events were emitted and that no raw PII ... ever lands in the `events` table." Reading every file's skip gate against `ci.yml`'s actual `e2e` job env block (`RUN_E2E=1`, `TEST_LOGIN_ENABLED=true`, `TEST_LOGIN_TOKEN` set — but **not** `E2E_UNLOCK_SUITE` or `E2E_CAPACITY_ENFORCED`):

| File | Gate | Executes in CI today? |
|---|---|---|
| `events-idempotency.e2e.test.ts` | `skipIf(!RUN)` | **Yes** — direct DB insert, no auth needed |
| `profile-idempotency.e2e.test.ts` | `skipIf(!RUN)` | **Yes** — direct DB insert |
| `profiling-voice-spine.e2e.test.ts` | `skipIf(!RUN)` | **Yes** — inserts the worker directly, bypasses login |
| `resume-signed-url.e2e.test.ts` | `skipIf(!RUN)` | **Yes** — ops routes, no worker login |
| `rls-spine.e2e.test.ts` | `skipIf(!RUN)` | **Yes** — `SET ROLE`-based |
| `referral-round-trip.e2e.test.ts` | `skipIf(!RUN)` | **Yes — the only suite that logs a worker in via `POST /auth/test-login` and calls `POST /consent/accept` over live HTTP in CI today** |
| `phase1-onboarding.e2e.test.ts` | file-level `skipIf(!RUN)`, but the ONE substantive test is `it.skip("logs in → consents → chats → extracts → confirms → generates a resume...")` | **No** — only a separate, unrelated RLS-only test in the same file runs; the actual journey test **never executes** |
| `contact-unlock.e2e.test.ts` | `skipIf(!RUN_UNLOCK)`, `RUN_UNLOCK = RUN && E2E_UNLOCK_SUITE==="1"` | **No** — `E2E_UNLOCK_SUITE` unset in `ci.yml` |
| `payer-capacity.e2e.test.ts`, `payer-tenancy.e2e.test.ts`, `phase1-flow.e2e.test.ts`, `swipe-to-apply.e2e.test.ts` | `describe.skip(...)` unconditional | **No — never, regardless of any env var** |

**Net: 6 of 12 e2e files run at least one test in CI; 5 files never execute a single test body under any committed configuration; 1 file (`phase1-onboarding`) runs but its only meaningful test is itself skipped.** The full Phase-1 worker journey — login → consent → chat → extract → confirm → resume, the flow this platform exists to run — **does not execute anywhere in CI today**. This is not hidden: every unconditionally-skipped file and the `phase1-onboarding` `it.skip` carries an in-code comment explaining the blocker (worker OTP went real-only, `d2f228e`, removing the `dev_otp` echo the suites depended on) and pointing at the fix already built — `POST /auth/test-login` (D-3 seam), which **is** armed in CI and **is** what `referral-round-trip.e2e.test.ts` already uses successfully. The rewiring is explicitly flagged as pending in `tests/e2e/README.md`'s own "TODO — un-skip the worker suites" section — not surfaced here for the first time, but not done either, and 5 of 12 e2e files plus the one journey test that matters most are the accumulated cost.

### 3.1 A contradiction worth an owner-verification run, not an assumption

`contact-unlock.e2e.test.ts`'s own gating comment (added `c9f202be`, 2026-08-01, "TD129") states that after the D-3 login fix, un-skipping exposed a second blocker: *"6 of 8 tests failed on `POST /consent/accept -> 500`... `ERROR: permission denied for table workers`... the role the e2e API runs as does not clear [the REVOKE from migration 0004]."* That's why `E2E_UNLOCK_SUITE` stays unarmed.

Reading migration `0004_workers_force_rls_revoke.sql`'s own comment against `ci.yml`'s `e2e` job produces a tension not resolvable by static reading alone: migration 0004 states "the backend connects on a DIRECT Postgres connection as the `postgres` role (BYPASSRLS)," and the `e2e` job's `DATABASE_URL` is exactly that role — a superuser that bypasses both RLS and REVOKE unconditionally. **`referral-round-trip.e2e.test.ts` — not gated behind any extra flag, and running in CI today — performs the identical sequence** (`test-login` → `consent/accept`) that TD129 says 500s. **Either TD129's diagnosis was accurate for the run it cites and has since been resolved by an unrelated change, or `referral-round-trip` is presently red in CI for the same reason and it's gone unnoticed** (CI failures on this job aren't separately tracked per-file in anything this audit read). **UNKNOWN, not verified either way** — resolving it needs a live CI run log or a local repro (`RUN_E2E=1 E2E_UNLOCK_SUITE=1 TEST_LOGIN_TOKEN=... pnpm --filter @badabhai/e2e test` against a fresh migrated DB). Given `contact-unlock.e2e.test.ts` covers the platform's most security-sensitive money+PII flow, this deserves a direct answer before trusting either the "it's blocked" or "it would pass" story.

### 3.2 A working precedent for un-gating exists in the same file

`ci.yml`'s `e2e` job's "Matching V1 DB-backed release gates" step shows the exact fix pattern the 5 permanently-skipped suites need: those gates were also `skipIf(RUN_DB_TESTS !== "1")` with `RUN_DB_TESTS` unset anywhere (TD122) until PR #538 armed it **and** added an explicit assertion that the expected test-file count actually ran (`grep -qE 'Test Files +4 passed \(4\)'`), specifically to prevent the "vacuous pass" failure mode where a broken filter makes zero tests run and the step still exits 0. That discipline is not yet applied to `tests/e2e/`'s own skipped files.

## 4. Critical business flow coverage matrix

| Flow | Unit | Integration/HTTP | E2E (real API+DB) | Verdict |
|---|---|---|---|---|
| **OTP request/verify** | Deep (`otp.service.test.ts`) | `auth.controller.test.ts` (mocked service) | **None** — every e2e suite needing a session uses the test-login seam instead | The actual `/auth/otp/request`→`/verify` HTTP round trip has no live-DB proof anywhere in CI |
| **PIN set/verify/reset** | Exceptional (`pin.service.test.ts`, 906 lines) | Controller-level, reset-request cap only | **Zero** — grepped `tests/e2e/*.ts` for any `/auth/pin/*` reference, none | Deepest unit coverage of any flow sampled; **no integration or E2E test anywhere** for PIN auth |
| **Contact unlock/reveal (payer)** | Exceptional (`unlocks.service.test.ts`, 750 lines) | Controller/guard unit only | **Written, comprehensive, NOT armed in CI** (§3) | Invariants proven at unit level; the full HTTP+DB+guard chain unproven anywhere CI actually runs |
| **Payment webhook (Razorpay)** | Deep across 3 files | **Yes** — real NestJS app + real HTTP requests | None | Strong 3-tier coverage; no e2e test proves the full chain end to end |
| **Pseudonymization gateway** | Exceptional (`test_pseudonymize.py`, 782 lines) | N/A (pure function) | N/A — Batch 1 verified "every router calls it" by **manual code read**, not a runtime assertion | Function exhaustively tested; that it's actually invoked before every provider call rests on a static audit, not a runtime test |
| **Admin PII reveal** | Exceptional (4 test files) | Present via `guard-contract.test.ts` | None (flag default-off) | Best-tested critical route in the sample; no e2e gap given the flag's own off-by-default posture |
| **Consent gate** | Exceptional (`consent.guard.test.ts`) | `consent.controller/service.test.ts` | **Yes, indirectly** — `referral-round-trip.e2e.test.ts` calls real `POST /consent/accept` over HTTP | The one gate with genuine E2E proof over a live HTTP+DB stack |

## 5. Coverage-threshold and mutation-testing posture

`ci.yml` enforces Vitest coverage thresholds (`vitest.config.ts`: lines/functions/statements ≥75%, branches ≥73%) via `pnpm test -- --coverage`, with an explicit comment (TD9) noting omitting `--coverage` would silently make the thresholds decorative. A real, armed gate.

**No mutation-testing framework exists anywhere in the repo** — no Stryker config, no `mutmut`/`cosmic-ray`. Not run by this audit (out of scope). What this means concretely: the "mutation bar" (a passing test is evidence only once seen to fail) is not automated anywhere — it rests entirely on the discipline visible in the sampled tests themselves (many of which, per §2, do encode exactly the specific-state-change assertions a mutation test would want). That discipline is real but **NOT VERIFIED by tooling**, only by this auditor's read-only assessment.

## 6. Frontend/mobile coverage shape

apps/payer-web (85 files) has by far the deepest frontend suite, matching its status as the actively-built product surface. apps/admin-web (9) and apps/web (7) are comparatively thin — Batch 1's `BL-1` (deployment path unconfirmed for both) means whether that thinness is proportionate to actual production exposure is **UNKNOWN**. apps/worker-app has a genuine full-journey widget test (`test/e2e/app_journey_test.dart`, splash→login→OTP→consent→chat→profile→building→4-tab shell, headless via `flutter test` against a `MockApiClient`) — valuable UI-state-machine coverage but **not a substitute** for the disabled `phase1-onboarding.e2e.test.ts`: it proves Flutter navigation/widget-state consistency against canned mocks, not that the real API's wire contract/events/PII-handling match what the mock assumes. 143 (worker-app) + 36 (payer-app) Dart test files is a large raw count; only the one full-journey file was sampled for quality — **NOT COVERED in this pass** beyond that.

## 7. What is NOT covered / UNKNOWN

Whether `referral-round-trip.e2e.test.ts` is actually green in current CI (§3.1, needs a live run log); mutation-kill rate (no tooling exists); real-vs-vacuous quality of the 178 remaining Flutter test files beyond the one sampled; whether apps/web's/admin-web's thinner test count is proportionate (depends on Batch 1's `BL-1`); `packages/*`'s 58 test files counted but not individually sampled. No suite was actually executed by this audit — every CI-execution claim in §3 is derived from reading skip-gate code against `ci.yml`'s literal env values.

## 8. Summary for the remediation backlog

**The single highest-leverage, best-evidenced gap**: the Phase-1 worker journey does not execute in CI. The fix is not a redesign — the unblocking seam (`POST /auth/test-login`) is already built, already armed in CI, already proven working by `referral-round-trip.e2e.test.ts`. What remains is the suite-rewrite `tests/e2e/README.md` already documents (swap the OTP-login helper for one `test-login` call in `phase1-onboarding`, `contact-unlock`, `payer-tenancy`, `payer-capacity`, `swipe-to-apply.e2e.test.ts`), plus resolving the TD129 permission-denied question (§3.1) as a precondition for `contact-unlock` specifically. PIN auth has zero integration/E2E coverage with no documented in-flight fix — a clean gap, not a known-and-tracked one. `tests/contract/`/`tests/security/` being empty scaffolding two months in is a process gap worth a named decision (fill or retire) rather than continued silent drift.

---

**Files referenced**: `tests/README.md`, `tests/e2e/README.md`, all 12 `tests/e2e/*.e2e.test.ts`, `tests/{contract,security}/README.md`, `.github/workflows/ci.yml` (~lines 190–660), `packages/db/migrations/0004_workers_force_rls_revoke.sql`, `apps/api/vitest.config.ts`, and the 18 sampled test files listed in §2 (full paths in the source investigation).
