# Test Matrix

Module × test-type × command/steps × expected × current × owner × status.
Current results from the 2026-06-29 baseline ([QA_EVIDENCE.md](QA_EVIDENCE.md)). Update after each run.

## Automated gates

| Module | Type | Command | Expected | Current (2026-06-29) | Owner | Status |
| ------ | ---- | ------- | -------- | -------------------- | ----- | ------ |
| Monorepo TS | lint | `pnpm lint` | exit 0 | ❌ 1 err+1 warn (ADMIN-3b WIP) | Divyanshu | BROKEN (WIP) |
| Monorepo TS | typecheck | `pnpm typecheck` | exit 0 | ❌ TS2304 ×2 (ADMIN-3b WIP) | Divyanshu | BROKEN (WIP) |
| Monorepo TS | unit/integration | `pnpm test` | all pass | ✅ api 1141, payer-web 517, +pkgs | all | DONE |
| Monorepo TS | build | `pnpm build` | exit 0 | ✅ 13/13 (nest transpile; not type-gate) | all | VERIFY |
| payer-web | DS token gate | `pnpm lint:oxlint` | exit 0 | ✅ pass | Utkarsh | DONE |
| Monorepo | format | `pnpm format:check` | exit 0 | ❌ 469 files (not a CI gate) | any | PARTIAL |
| E2E (Phase-1) | e2e | `RUN_E2E=1 pnpm --filter @badabhai/e2e test` (real PG+Redis) | flow passes | ⏭️ 143 skipped locally (CI only) | QA/DevOps | VERIFY |
| Staging smoke | smoke self-test | `node --test scripts/staging-smoke.test.mjs` | pass | (CI green) — rerun locally | DevOps | VERIFY |
| ai-service | unit | `pytest` (apps/ai-service) | all pass | ✅ ~220 pass, 1 skip | ai-engineer | DONE |
| ai-service | lint | `ruff check .` | exit 0 | ⚠️ not installed locally (CI covers) | ai-engineer | VERIFY |
| worker-app | analyze+test | `flutter analyze && flutter test` | pass | ⚠️ flutter not installed locally (CI `worker-app.yml` blocking) | Flutter dev | VERIFY |
| Secrets | scan | security-scan.yml (gitleaks/semgrep/audit) | no findings | advisory (continue-on-error) | DevOps | PARTIAL |
| Migrations | drift/sequence | supabase-checks.yml | no drift | advisory | database-architect | VERIFY |

## Alpha-gate click-through scripts (manual, run on staging once D1 done)

| # | Gate | Steps | Expected | Status |
| - | ---- | ----- | -------- | ------ |
| 1 | Payer company | signup/login → dashboard → post job → manage → applicants → unlock/reveal → wallet → capacity/top-up | each step works; faceless; mock credits move; routed handle only | BLOCKED (staging) |
| 2 | Agency demand | agent login → agency dashboard → create vacancy → manage own → invite hook → faceless summaries → company blocked from agency | agent-only; `assertNoAgencyPII` holds; k-anon counts | BLOCKED (staging) |
| 3 | Worker app (B1) | open app → real OTP login → consent → name → chat → profile extract → resume TEXT preview | flow completes on handset; no PII to LLM/logs | BLOCKED (staging) |
| 4 | OTP safety | request OTP → real send (capped) → wrong code neutral → breaker at cap=0 → kill-switch → logs show no phone/code | breaker fires; no raw phone/code in logs | BLOCKED (staging/OTP-7) |
| 5 | RBAC | owner vs recruiter; agent vs employer; server-side fail-closed | recruiter 404s on billing/team; employer 404s on agency | PARTIAL (unit-tested; staging pending) |
| 6 | Health/staging | `/health` → DB up → Redis up → smoke | 200 with up/up; no secrets | BLOCKED (staging) |

## Security checks (run every release)
| Check | How | Current |
| ----- | --- | ------- |
| No raw phone/code in logs | grep API logs; otp.service logs phone_hash prefix only | ✅ verified in code |
| No secrets in frontend | grep `NEXT_PUBLIC_` | ✅ no secret misuse |
| `DEV_QUICK_LOGIN` off/absent | grep apps/api/src | ✅ DEAD (removed) |
| RBAC fail-closed | unit tests `org-roles`, `roles` | ✅ tests green |
| Agency no raw PII | `assert-no-agency-pii` tests | ✅ tests green |
| Events PII-free | event-schema validation tests | ✅ tests green |
| Money-route auth | guards on unlocks/posting-plans | ❌ posting-plans unguarded (P1) |
| Circuit breaker / kill-switch | otp.service cap=0 path + tests | ✅ tests green |

---
_Mark a row DONE only when run with evidence in [QA_EVIDENCE.md](QA_EVIDENCE.md). Manual gates need a dated screenshot/note._
