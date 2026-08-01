# Release Readiness

Go/No-Go checklist. **Staging readiness** and **production readiness** are separate gates.
Current verdict: **STAGING = DEPLOYED (manually, 2026-07-18) — alpha gates partly unproven** ·
**PRODUCTION = NOT READY (multiple gates).**

> **Corrected 2026-08-01 (owner).** This file previously read "STAGING = NOT READY (not deployed)",
> which contradicted [PROJECT_STATUS.md](PROJECT_STATUS.md)'s "Staging LIVE since 2026-07-18".
> PROJECT_STATUS was right. The deploy was performed **manually, outside
> [`staging-cd.yml`](../../.github/workflows/staging-cd.yml)** — which is why GitHub Actions shows
> **zero runs** of that workflow (verified 2026-08-01). Zero pipeline runs is evidence about the
> *automation*, not about the deploy. That automation gap is tracked as **TD123**.

Release Readiness %: **25%** — **NOT re-scored on 2026-08-01.** This pass corrected false
"not deployed" claims only. The percentage predates it and no evidence was captured to move it.

## Staging readiness (the alpha gate)
| Item | Required | Status | Evidence / Blocker |
| ---- | -------- | ------ | ------------------ |
| Host deployed | persistent API up | ✅ | **manual deploy 2026-07-18**, outside `staging-cd.yml` (owner-confirmed 2026-08-01). D1 closed by the deploy; the pipeline gap is TD123 |
| `staging` GitHub Environment + secrets | all present | ❌ | still not created — the manual deploy bypassed it, so `staging-cd.yml` would still no-op. **TD123** |
| `/health` 200 (DB+Redis up) | yes | ⚠️ | attested live per [PROJECT_STATUS](PROJECT_STATUS.md); **no captured artifact** (`docs/qa/evidence/staging/` empty) |
| Migrations applied to staging DB | through `0043` | ⚠️ | `0042`+`0043` applied 2026-07-18. **The Matching V1 train (`0052`–`0057`) is authored, NOT applied** — Divyanshu runs it per the ordered runbook (owner ruling: agents never run migrations) |
| Real OTP activation (OTP-7) | capped, synthetic | ✅ | real OTP via Fast2SMS live per [PROJECT_STATUS](PROJECT_STATUS.md) (D2 closed) |
| Smoke test green | `pnpm staging:smoke` | ❌ | no evidence it has been run against the deployed host — unchanged by the deploy correction |
| Branch green (lint/typecheck/test/build) | yes | ✅ | `ci-required` pass on `f28279f` (#526 merge, 2026-08-01). The ADMIN-3b lint/typecheck red noted here was stale |
| Rollback note | written | ✅ | [rollback-guide.md](../rollback-guide.md) |
| Observability | logs+events visible | ✅(doc) | [observability-runbook.md](../observability-runbook.md) — still **verify on staging** |

## Production readiness
| Area | Required | Status | Blocker |
| ---- | -------- | ------ | ------- |
| Auth | non-forgeable sessions, real JWT secret | ⚠️ | real secret on staging/prod only |
| OTP | real-only, breaker, kill-switch, capped | ✅ code / ❌ proven | real send unproven (D2) |
| Payer flows | money routes authz (LC-1) | ❌ | posting-plans unguarded (P1); unlock/reveal body payer_id (D3) |
| Worker app | handset-proven | ⚠️ | B1 worker capstone verified 2026-07-25 (Divyanshu) + swipe verified on real handset (Prakash) — **attested, not captured** (`docs/qa/evidence/staging/` empty) |
| Agency | faceless demand; payouts/KYC built mock+gated | ✅ (alpha scope) | payouts/KYC machinery shipped OFF (`AGENCY_PAYOUTS_ENABLED`, PR #508); go-live needs legal/DPDP + §7 real money + 2 fix-before-flip items ([ADR-0022 Amdt 2](../decisions/0022-agency-supply-portal.md)) |
| Health | no secret leak | ✅ | verified in code |
| Staging | exists + smoke | ⚠️ | exists (manual deploy 2026-07-18); **smoke still unproven** + CD pipeline never exercised (TD123) |
| Security | RLS, CORS, trust-proxy, secrets mgr | ❌ | RLS deferred (D6); TD30/TD25 open |
| Payments | real provider + reconciliation | ❌ | mock only (Phase-7) |
| Legal | DPDP prod consent + erasure | ❌ | LEGAL_GATE |
| Docs | DR plan + cost doc | ❌ | both pending |
| Rollback | rehearsed | ⚠️ | guide exists; not rehearsed |

## Go/No-Go summary
- **Staging/alpha:** the three blockers this line used to name are all closed — D1 (deploy) done
  manually 2026-07-18, branch green (`ci-required` on `f28279f`), B1 worker capstone verified
  2026-07-25. What remains is **proof, not build**: `pnpm staging:smoke` has never been run against
  the deployed host, and `docs/qa/evidence/staging/` is still empty, so every staging claim above is
  team attestation rather than a captured artifact. Separately, `staging-cd.yml` has **never run**
  (TD123) — today's staging can be redeployed only by repeating the manual steps.
- **Production:** **NO-GO** — LC-1 money-route auth, RLS, real providers, DR/cost docs, legal copy all outstanding.

## Release procedure (when staging is ready) — see [release-check] / [bb-deployment]
1. CI green (incl. lint+typecheck) on the merge commit.
2. Migrations ordered (expand→migrate→contract); rollback noted.
3. Safe-default env gates verified OFF (AI/payments/WhatsApp real = false).
4. Deploy → `/health` 200 → `pnpm staging:smoke`.
5. Manual alpha-gate scripts ([TEST_MATRIX.md](TEST_MATRIX.md)) with evidence.
6. Tag immutable deploy; record rollback command.

---
_No release decision is valid without the matching [QA_EVIDENCE.md](QA_EVIDENCE.md) rows._
