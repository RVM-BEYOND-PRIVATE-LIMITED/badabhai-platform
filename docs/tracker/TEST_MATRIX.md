# Test Matrix

Module × test-type × command/steps × expected × current × owner × status.

**Last full re-run: 2026-07-16** — every "Automated gates" row below was executed on
`main` @ `384d277` (clean tree) for this update; no result is carried forward from an
older snapshot. Manual/click-through rows still reference the 2026-07-10 evidence audit
([QA_EVIDENCE.md](QA_EVIDENCE.md)). Large artifacts live in
[`docs/qa/evidence/`](../qa/evidence/); the written index is [QA_EVIDENCE.md](QA_EVIDENCE.md).
Update both after each run.

> **Headline:** the TS monorepo is **fully green** (lint/typecheck/test/build all exit 0 —
> **2,465 tests / 23 tasks in 35s**). Two real gaps: **ai-service `pytest` is RED locally
> (2 failed)** and the **local Flutter toolchain (3.27.4) is below the required 3.35.0**, so
> neither Flutter app can be analyzed/tested on this machine. **No flow is proven on staging** —
> every manual gate remains BLOCKED on the staging P0.

## Automated gates

| Module | Type | Command | Expected | Current (2026-07-16, `384d277`) | Owner | Status |
| ------ | ---- | ------- | -------- | -------------------- | ----- | ------ |
| Monorepo TS | lint | `pnpm lint` | exit 0 | ✅ exit 0 — re-run 2026-07-16 | Divyanshu | DONE |
| Monorepo TS | typecheck | `pnpm typecheck` | exit 0 | ✅ exit 0 — re-run 2026-07-16 | Divyanshu | DONE |
| Monorepo TS | unit/integration | `pnpm test` | all pass | ✅ **23/23 tasks, 2,465 tests, 35.4s** — api **1456** (142 files), payer-web **529** (57), event-schema 125, config 89, validators 50, db 47, reach-engine 40, ai-contracts 33, web 30, pricing 29, reach-learn 24, taxonomy 13 | all | DONE |
| Monorepo TS | build | `pnpm build` | exit 0 | ✅ exit 0 (nest transpile; not a type-gate) | all | DONE |
| payer-web | DS token gate | `pnpm lint:oxlint` (root script) | exit 0 | ✅ exit 0 — re-run 2026-07-16 | **Prakash / FE** | DONE |
| Monorepo | format | `pnpm format:check` | exit 0 | ❌ **560 files** need Prettier (was 469 — drifting). **Not a CI gate** | any | PARTIAL |
| E2E (Phase-1) | e2e | `RUN_E2E=1 pnpm --filter @badabhai/e2e test` (real PG+Redis) | flow passes | ⏭️ **10 suite files skipped** (RUN_E2E unset locally): contact-unlock, events-idempotency, payer-capacity, payer-tenancy, phase1-flow, phase1-onboarding, profile-idempotency, resume-signed-url, rls-spine, swipe-to-apply | QA/DevOps | **VERIFY — never run here** |
| Staging smoke | smoke self-test | `pnpm staging:smoke:test` | pass | not re-run locally (`scripts/staging-smoke.test.mjs` present) | DevOps | VERIFY |
| Staging smoke | live smoke | `pnpm staging:smoke` | 200 up/up | ⛔ **cannot run — no staging** | DevOps | BLOCKED |
| **ai-service** | unit | `pytest` (apps/ai-service) | all pass | ⚠️ **RED locally: 2 failed, 389 passed, 2 skipped** (2026-07-16). See **T1** — env-isolation gap, *not* a product regression. CI runs the same suite ([ci.yml:84](../../.github/workflows/ci.yml)) and `main` merged green ⇒ likely local-`.env`-dependent | ai-engineer | **PARTIAL** |
| ai-service | lint | `ruff check .` | exit 0 | ⚠️ **ruff NOT installed locally** (confirmed) — CI covers ([ci.yml:81](../../.github/workflows/ci.yml)) | ai-engineer | VERIFY |
| **worker-app** | analyze+test | `flutter analyze && flutter test` | pass | ⚠️ **local Flutter 3.27.4 < required 3.35.0** — cannot `pub get`. CI `worker-app.yml` **BLOCKING**, pinned **3.35.7** | Rishi | **VERIFY — never run here** |
| **payer-app** *(new row)* | analyze+test | `flutter analyze && flutter test` | pass | ⚠️ same 3.27.4 blocker. CI `payer-app.yml` **BLOCKING**, pinned **3.35.7**, path-filtered to `apps/payer-app/**` | Rishi | **VERIFY — never run here** |
| Secrets | scan | `security-scan.yml` (gitleaks/semgrep/audit) | no findings | advisory (`continue-on-error: true`) — flip-to-blocking criteria in the workflow header | DevOps | PARTIAL |
| Migrations | drift/sequence | `supabase-checks.yml` | no drift | advisory. **40 migrations** (0000–0039; 0038+0039 owner-applied 2026-07-15) | database-architect | VERIFY |
| **TAX / ADR-0030 runners** *(new row)* | data/offline | `db:seed:skills`, `db:embed:skills`, `db:growth:cluster`, `db:retag:skills` | idempotent, human-gated | **no matrix coverage** — human-gated by design; growth/retag never auto-run | ai-engineer / DBA | **GAP** |

## Alpha-gate click-through scripts (manual, run on staging once D1 done)

| # | Gate | Steps | Expected | Status |
| - | ---- | ----- | -------- | ------ |
| 1 | Payer company | signup/login → dashboard → post job → manage → applicants → unlock/reveal → wallet/ledger → capacity/top-up → plan/boost | each step works; faceless; mock credits move; routed handle only | **BLOCKED (staging)** |
| 2 | Agency demand | agent login → agency dashboard → create vacancy → manage own → invite hook → faceless summaries → company blocked from agency | agent-only; `assertNoAgencyPII` holds; k-anon counts | **BLOCKED (staging)** |
| 3 | Worker app (B1) | open app → real OTP login → consent → name → chat → profile extract → resume PDF | flow completes on handset; no PII to LLM/logs; PDF opens; event chain exists | **PARTIAL** — 60 audited **emulator/local** screenshots (2026-07-09, [QA_EVIDENCE 2026-07-10](QA_EVIDENCE.md)); worker wiring real on local API, **mock OTP**. Still needs: handset + staging `/health` + events chain + clean logcat + PDF-open proof |
| 4 | OTP safety | request OTP → real send (capped) → wrong code neutral → breaker at cap=0 → kill-switch → logs show no phone/code | breaker fires; no raw phone/code in logs | **BLOCKED (staging / OTP-7)** |
| 5 | RBAC | owner vs recruiter; agent vs employer; server-side fail-closed | recruiter 404s on billing/team; employer 404s on agency | PARTIAL (unit-tested; staging pending) |
| 6 | Health/staging | `/health` → DB up → Redis up → smoke | 200 with up/up; no secrets | **BLOCKED (staging)** |
| 7 | Payer app (Flutter) *(new row)* | payer-app REAL-mode → login → postings → applicants → unlock/reveal | mirrors gate 1 on mobile; no PII; mock credits | **BLOCKED (staging)** — app merged (#189), CI gate live (#243) |

## Security checks (run every release)

| Check | How | Current |
| ----- | --- | ------- |
| No raw phone/code in logs | grep API logs; otp.service logs phone_hash prefix only | ✅ verified in code |
| No secrets in frontend | grep `NEXT_PUBLIC_` | ✅ no secret misuse |
| `DEV_QUICK_LOGIN` off/absent | grep apps/api/src | ✅ DEAD (removed) |
| RBAC fail-closed | unit tests `org-roles`, `roles` | ✅ tests green |
| Agency no raw PII | `assert-no-agency-pii` tests | ✅ tests green |
| Events PII-free | event-schema validation tests | ✅ 125 tests green |
| **Money-route auth** | guards on unlocks / posting-plans | ✅ **LC-1 CLOSED on the payer surface** — verified 2026-07-16: [`payer-unlocks.controller.ts:40`](../../apps/api/src/payer-portal/payer-unlocks.controller.ts) puts the **whole class** behind `PayerAuthGuard`; `POST /payer/unlocks` + `/unlocks/:id/reveal` derive `payer_id` from the **session** (XB-A, never body), and reveal enforces ownership at the chokepoint. `posting-plans` payer-authed (#179). **Residual is OPS-INTERNAL only:** ops [`unlocks.controller.ts`](../../apps/api/src/unlocks/unlocks.controller.ts) keeps `InternalServiceGuard` as a deliberate safe-interim (TD33/TD50), not called by payer-web.<br>⚠️ **The prior "LC-1 open / body payer_id" entry here — and the same claim in PROJECT_STATUS.md and the 2026-07-10 endpoint audit — was a PHANTOM**: it conflated the ops controller with the payer one. CLAUDE.md §8 has it right. |
| **Real-call gate holds under test** *(new row)* | `pytest` must never reach a real provider | ❌ **FAILING locally** — a unit run fired a **real Gemini embedding call** (`skill_embedding provider HTTP 400`). See **T1**. |
| Circuit breaker / kill-switch | otp.service cap=0 path + tests | ✅ tests green |

---

## What's left — open test tasks

**T1 · ai-service pytest RED locally — conftest env-isolation gap** · owner **ai-engineer** · **P1**
[`tests/conftest.py`](../../apps/ai-service/tests/conftest.py) exists specifically to neutralize a
developer's real-call `.env` (it forces `AI_ENABLE_REAL_CALLS=false`, `AI_REAL_CALL_TASKS=""`, and blanks
`GEMINI_FLASH_API_KEY`, `ANTHROPIC_API_KEY`, `SARVAM_API_KEY`, `LITELLM_API_KEY`, `GEMINI_API_KEY`). It was
written **before** the ADR-0030 TAX surfaces and does **not** neutralize their settings, so two tests fail:
- `test_cost4_templated_default.py::test_extraction_still_calls_the_llm_in_real_mode` →
  `RuntimeError: skill_embedding provider HTTP 400` at [`app/ai/embeddings.py:110`](../../apps/ai-service/app/ai/embeddings.py)
  — **a real outbound Gemini embedding call fired from a unit test.** That is exactly what conftest exists to
  prevent (invariant #5: real calls gated OFF by default). Real-spend risk on any dev machine with a real `.env`.
- `test_skill_store.py::test_extract_wiring_inert_when_flag_off` → asserts canonicalization is inert with the
  flag off; got 4 canonicalize calls (`['cnc-machining', …, 'record']`) ⇒ the local `.env` arms
  `skill_canonicalize_enabled` past the "default OFF" the test asserts.

**Fix:** extend the conftest `autouse` fixture to pin `skill_canonicalize_enabled=False` and keep the
embedding task out of the real-call allowlist, so `Settings()` cannot inherit either from a developer `.env`.
**Also confirm CI is actually green on `main`** — I could not verify the CI run from here, and the tracker's
"pytest ✅" claim dates from PR #187, *before* the TAX series landed.

**T2 · Local Flutter toolchain too old** · owner **Rishi / DevOps** · **P1**
Local **3.27.4** vs CI-pinned **3.35.7** and the `>=3.35.0` bound TD61 (#243) declared. Neither worker-app nor
payer-app can `pub get` / `analyze` / `test` locally. Upgrade local Flutter to 3.35.7 to match CI.

**T3 · E2E has never run in this environment** · owner **Divyanshu / QA** · **P1**
10 suites skipped (RUN_E2E unset). Needs `pnpm db:migrate` on the local PG + `RUN_E2E=1`, and `RUN_E2E`
enabled on staging so the hard-skipped suites actually execute.

**T4 · Zero-coverage e2e domains** · owner **Divyanshu** · **P2**
No e2e for: `/payer/agency/*`, org/team, admin smoke (login + event read + kill-switch), and the
API→ai-service cross-service call (extraction + pseudonymization fail-closed). Note unlock/reveal **does** have
`contact-unlock.e2e.test.ts` — but it sits in the skipped set (T3), so it has never run here.

**T5 · Prettier drift** · owner **any** · **P3**
560 files fail `format:check` (up from 469). Not a CI gate — either fix in one sweep or drop the row.

**T6 · Staging P0 — blocks gates 1, 2, 4, 6, 7 and half of 3** · owner **Prakash** · **P0**
Decided 2026-06-29, deadline was 2026-07-04. Still no `docs/qa/evidence/staging/`, no `/health` 200.
**Nothing in the manual half of this matrix can move until this lands.**

---
_Mark a row DONE only when run with artifacts in `docs/qa/evidence/` and an index row in
[QA_EVIDENCE.md](QA_EVIDENCE.md). Manual gates need dated screenshots, event/log exports, and notes._
