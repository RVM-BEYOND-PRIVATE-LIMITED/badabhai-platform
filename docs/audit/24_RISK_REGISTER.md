# 24 — Risk Register (Batch 1 Reconciliation)

This is **not a second risk register**. The authoritative, actively-maintained register is
[`docs/registers/risks-register.md`](../registers/risks-register.md) (36 rows, R1–R36, restored
2026-08-12 after the docs purge — see
[17_GIT_HISTORY_AUDIT.md](17_GIT_HISTORY_AUDIT.md)). This document records what this audit did
against it: which existing rows were independently re-verified as current, and which new rows
this audit's findings warrant, formatted for direct appending by that register's owner rather
than forked into a competing document.

## Existing rows independently re-verified during this audit

No drift found on any of the following — each was checked against current code, not assumed
current from the register's own text:

| Row | Re-verification finding |
|---|---|
| R1 (RLS not finalized) | Confirmed platform-wide (65/65 tables, not just the payer subset): 0 `CREATE POLICY` anywhere. Accurate and current. |
| R17 (payments mock-only) | `PAYMENTS_ENABLE_REAL` and 4 sibling real-provider flags confirmed not wired through CI secrets bridge or staging compose — cannot be armed by a deploy. |
| R24 (admin portal 4th principal) | Design's named controls (spine read-only, PII-free events, reason-gated reveal, deny-by-default RBAC, `assertAdminAuthConfig` fail-closed) all verified present in code. |
| R28 (worker PII ops routes) | `workers.controller.ts`'s three routes verified still on `InternalServiceGuard`, still pinned in `guard-contract.test.ts`. Closed, no regression. |
| R30 / R32 (pseudonymization gaps, accepted-not-fixed) | Both confirmed still open, both still gated only by `AI_REAL_CALLS_KILL_SWITCH`, both signed rulings (2026-08-01, 2026-08-12) intact in the register. Single enforced gateway re-verified — no router reaches a provider client with unpseudonymized text. |
| R31 (pricing catalog auth) | `PUT/GET /pricing/catalog`, `GET /pricing/quote` confirmed still on `InternalServiceGuard`. Closed, no regression. |
| R36 (PACE ops routes) | Confirmed still on `InternalServiceGuard`, pinned in `guard-contract.test.ts`. Closed, no regression. |
| TD67 (`AI_INTERNAL_TOKEN` empty-string arming) | Re-verified fixed at the Pydantic layer (`min_length=16` fails at `Settings()` construction, not request time) — the historical vacuous-arm bug class cannot recur. Both compose files correctly declare it as a valueless pass-through, not `${VAR:-}`. |

## New rows proposed (for the register owner to append)

Formatted to match the existing register's schema (`ID | Risk | Sev | Status | Mitigation |
Owner`). IDs continue from R36. Full evidence for each is in
[15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md).

| ID | Risk | Sev | Status | Mitigation | Owner |
| -- | ---- | --- | ------ | ---------- | ----- |
| R37 | **`guard-contract.test.ts` — the single source of truth for which guards protect every route — omits 17 of 62 controllers**, 11 beyond what `docs/payer-agent/SECURITY_AUDIT.md`'s PAY-SEC-06 already found (6 payer/agency controllers). The 11 new ones include 4 admin controllers (`admin-directory`, `admin-entities`, `admin-finance`, `admin-kill-switch`) | Medium | Open | Every one of the 17 was individually read and its guard verified correct in code today — this is a regression-risk finding (no automated net catches a future dropped `@UseGuards`), not a live vulnerability. Fix: extend PAY-SEC-06's remediation to cover all 17. | Security + Backend |
| R38 | **`docs/legal-later`, the file R4 and `.claude/agents/system-architect.md` cite as where DPDP legal-copy placeholders live, does not exist in the repo** — same class of dead-doc reference as R2/R30/R32's already-broken `docs/ai/pseudonymization.md` link (deleted by the same 2026-08-05 purge, `eb151468`) | Low–Medium | Open | R4's "structural placeholder" claim currently has no reviewable artifact. Fix: either restore/recreate the file, or update R4 and the citing agent doc to point at wherever DPDP legal-copy placeholders actually live now. | Product + Security |
| R39 | **`apps/ai-service` has zero authentication by default in every committed environment** (dev and staging both leave `AI_INTERNAL_TOKEN` unset) — contained only by loopback-only port binding (`127.0.0.1:8000:8000`), a single control with no defense-in-depth if deploy topology changes | Low (informational — deliberate, documented) | Accepted | Confirmed not a regression; this is the repo's own documented "historical internal-only open posture." Loosely related to R27 (deploy-secrets posture) — revisit if the deploy topology ever moves off Docker Compose loopback binding (e.g. a future k8s deployment). | DevOps + Security |
| R40 | **Firebase Android API key is committed identically in both `apps/worker-app/android/app/google-services.json` and `apps/payer-app/android/app/google-services.json`** | Low (informational) | Accepted | Standard practice for Firebase Android apps — Google documents these as restricted by package name + SHA-1 fingerprint, not secrecy. GCP-console API restriction was not independently verified from the repo; worth a one-time confirmation given `PUSH_ENABLE_REAL` (FCM) is a human-gated real-provider flip per the register's own convention. | DevOps |

## What this audit did NOT change

No row in `docs/registers/risks-register.md` was edited, reworded, or reordered by this audit —
appending R37–R40 is left to that document's owner, consistent with this being a documentation
addition, not a decision. R37 and R38 are the two items that most warrant near-term attention
(both are coverage/documentation gaps, not active leaks); R39 and R40 are recorded for
completeness and require no near-term action.
