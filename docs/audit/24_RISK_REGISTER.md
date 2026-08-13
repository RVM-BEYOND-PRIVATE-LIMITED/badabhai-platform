# 24 — Risk Register (Audit Reconciliation, Batches 1 & 2)

This is **not a second risk register**. The authoritative, actively-maintained register is
[`docs/registers/risks-register.md`](../registers/risks-register.md) (36 rows, R1–R36, restored
2026-08-12 after the docs purge — see
[17_GIT_HISTORY_AUDIT.md](17_GIT_HISTORY_AUDIT.md)). This document records what this audit did
against it: which existing rows were independently re-verified as current, and which new rows
this audit's findings warrant, formatted for direct appending by that register's owner rather
than forked into a competing document. Batch 1 proposed R37–R40; Batch 2 adds R41–R45 below.

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

## New rows proposed — Batch 2

| ID | Risk | Sev | Status | Mitigation | Owner |
| -- | ---- | --- | ------ | ---------- | ----- |
| R41 | **`staging-demand-verify.yml`'s "guarded / inert by default" framing does not match its live secret topology** — its guard checks only that four secrets are non-empty and aren't literally the compose-internal placeholder host, with no check that `DATABASE_URL` is a disposable, non-production database. All four required secrets are present in the `staging` GH Environment right now — the **same** Environment and **same `DATABASE_URL` secret name** `deploy-lightsail` uses to reach "the real Postgres" backing the always-on Lightsail box. The workflow already ran to completion successfully once (2026-06-24), applying migrations and writing a synthetic fixture, against credentials still live today. Any collaborator with `workflow_dispatch` rights can re-run it now, and the guard will not stop them. | **High** | Open — **urgent, needs an owner decision before the next manual trigger** | Not a live incident (nobody has re-run it since the environment matured into production use, as far as this audit's read-only evidence shows) — this is a loaded gun, not a fired one. Fix (either): (a) provision a genuinely separate disposable database + a separate GH Environment before this workflow is ever run again, or (b) add a positive-match guard requiring `DATABASE_URL` to contain a disposable-DB marker, failing closed otherwise. See [12_CICD_AUDIT.md](12_CICD_AUDIT.md) F4 for full evidence. | DevOps + Security |
| R42 | **`supabase-checks.yml` (the migration-drift and migration-sequence gate protecting "Drizzle is source of truth") has been disabled at the GitHub platform level for a month**, invisibly — the YAML looks live to any reader, but `gh api` confirms `"state":"disabled_manually"`. 31 commits have advanced the migration chain since it stopped running, none checked by either job. The file was still edited (a dependency bump) after being disabled, with no PR/issue explaining why it was turned off. | Medium–High | Open | One-click platform fix (Settings → Actions → Enable workflow), not a code change. `ci.yml`'s `e2e` job still proves the migration chain *applies*, so this isn't a total blind spot — but the drift-vs-schema.ts and journal-consistency checks are providing zero signal until re-enabled. See [12_CICD_AUDIT.md](12_CICD_AUDIT.md) F2. | DevOps |
| R43 | **The Phase-1 worker journey (login → consent → chat → extract → confirm → resume) — the flow this platform exists to run — does not execute anywhere in CI.** 5 of 12 `tests/e2e/*.e2e.test.ts` files never run under any committed configuration, and the one file that should prove the full journey (`phase1-onboarding.e2e.test.ts`) has its only meaningful test itself `it.skip`ped. The unblocking seam (`POST /auth/test-login`) is already built, already armed in CI, and already proven working by a sibling suite (`referral-round-trip.e2e.test.ts`). | Medium | Open | The fix is a suite rewrite already documented as pending in `tests/e2e/README.md`'s own TODO, not a redesign. A related, unresolved contradiction (TD129's "permission denied" claim vs. `referral-round-trip`'s apparent success on the identical sequence) needs a live CI-log check before `contact-unlock.e2e.test.ts` specifically can be un-gated. See [14_TEST_AUDIT.md](14_TEST_AUDIT.md) §3. | QA + Backend |
| R44 | **The sole HTTP client between `apps/api` and `apps/ai-service` forwards no request/correlation id, and its failure path produces no event** — only an untagged log line. A total ai-service outage or a single failed call (chat turn, résumé generation, job-posting-chat) leaves no queryable trace tying the failure to the originating worker/payer request. This is the root cause of most of the "why did this request fail" gaps found in the observability audit. | Low–Medium | Open | Additive fix: thread `x-request-id`/`x-correlation-id` through the existing `post()` helper's headers (mirrors the already-working `x-ai-internal-token` pattern) and add ai-service-side middleware to read/log them. See [16_OBSERVABILITY_AUDIT.md](16_OBSERVABILITY_AUDIT.md) §4, §10. | Backend + AI |
| R45 | **Nine distinct operational runbooks are cited by path (some with section numbers) from live code and CI — `docs/rollback-guide.md` (4 citations in `ci.yml` alone), `docs/observability-runbook.md`, `docs/environment-variables.md`, `docs/supabase-workflow.md`, `docs/pii-key-rotation-runbook.md`, `docs/github-actions.md`, `docs/release-checklist.md`, and two `docs/ops/*-runbook.md` files — and none exist in the repository.** All were deleted by the same 2026-08-05 purge (`eb151468`) that took the risk register with it, and never recreated. An on-call engineer following the code's own pointers — e.g. the `deletion_sweep` SEV2 threshold `health.controller.ts` names — has nowhere to go for the "what do I do about it" half. | Medium | Open | Independently surfaced by three separate audit passes ([11_COMMAND_REFERENCE.md](11_COMMAND_REFERENCE.md), [12_CICD_AUDIT.md](12_CICD_AUDIT.md), [16_OBSERVABILITY_AUDIT.md](16_OBSERVABILITY_AUDIT.md) §9) — not a single-source claim. Fix: recreate at minimum `docs/rollback-guide.md` (actively cited by a live, currently-executing deploy job) before the others. | DevOps |

## What this audit did NOT change

No row in `docs/registers/risks-register.md` was edited, reworded, or reordered by this audit —
appending R37–R45 is left to that document's owner, consistent with this being a documentation
addition, not a decision. **R41 is the single item across both batches most warranting immediate
attention** — it describes a currently-exploitable path to running migrations and synthetic
fixtures against the production database secret, not merely a documentation or coverage gap.
R42, R43, and R45 are process/coverage gaps worth near-term action. R37, R38, R44 are lower
urgency. R39, R40 are recorded for completeness and require no near-term action.
