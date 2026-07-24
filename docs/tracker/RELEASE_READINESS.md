# Release Readiness

Go/No-Go checklist. **Staging readiness** and **production readiness** are separate gates.
Current verdict: **STAGING = NOT READY (not deployed)** · **PRODUCTION = NOT READY (multiple gates).**

Release Readiness %: **25%** (High confidence it is not release-ready).

## Staging readiness (the alpha gate)
| Item | Required | Status | Evidence / Blocker |
| ---- | -------- | ------ | ------------------ |
| Host deployed | persistent API up | ❌ | D1 open — no host |
| `staging` GitHub Environment + secrets | all present | ❌ | not created (staging-cd guard would no-op) |
| `/health` 200 (DB+Redis up) | yes | ❌ | depends on host |
| Migrations applied to staging DB | yes | ❌ | depends on host |
| Real OTP activation (OTP-7) | capped, synthetic | ❌ | D2 open |
| Smoke test green | `pnpm staging:smoke` | ❌ | depends on host |
| Branch green (lint/typecheck/test/build) | yes | ⚠️ | test+build green; **lint+typecheck red on ADMIN-3b WIP** |
| Rollback note | written | ✅ | [rollback-guide.md](../rollback-guide.md) |
| Observability | logs+events visible | ✅(doc) | [observability-runbook.md](../observability-runbook.md) — verify on staging |

## Production readiness
| Area | Required | Status | Blocker |
| ---- | -------- | ------ | ------- |
| Auth | non-forgeable sessions, real JWT secret | ⚠️ | real secret on staging/prod only |
| OTP | real-only, breaker, kill-switch, capped | ✅ code / ❌ proven | real send unproven (D2) |
| Payer flows | money routes authz (LC-1) | ❌ | posting-plans unguarded (P1); unlock/reveal body payer_id (D3) |
| Worker app | handset-proven | ❌ | B1 open |
| Agency | faceless demand; payouts/KYC built mock+gated | ✅ (alpha scope) | payouts/KYC machinery shipped OFF (`AGENCY_PAYOUTS_ENABLED`, PR #508); go-live needs legal/DPDP + §7 real money + 2 fix-before-flip items ([ADR-0022 Amdt 2](../decisions/0022-agency-supply-portal.md)) |
| Health | no secret leak | ✅ | verified in code |
| Staging | exists + smoke | ❌ | D1 |
| Security | RLS, CORS, trust-proxy, secrets mgr | ❌ | RLS deferred (D6); TD30/TD25 open |
| Payments | real provider + reconciliation | ❌ | mock only (Phase-7) |
| Legal | DPDP prod consent + erasure | ❌ | LEGAL_GATE |
| Docs | DR plan + cost doc | ❌ | both pending |
| Rollback | rehearsed | ⚠️ | guide exists; not rehearsed |

## Go/No-Go summary
- **Staging/alpha:** **NO-GO** until D1 (deploy) + branch green + B1. Single critical path = staging deploy.
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
