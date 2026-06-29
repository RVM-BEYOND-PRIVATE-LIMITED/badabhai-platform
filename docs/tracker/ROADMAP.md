# Roadmap — now → paid launch

Each phase: goal · in-scope · out-of-scope · blockers · acceptance · **test gate** · owner · target.

**Current position (2026-06-29):** Overall **72%** · Alpha **57%** · Release **28%**. Phase 0 nearly closed; **Phase 1 (B1 alpha-gate sprint) starts this week with a hard deadline of Friday 2026-07-04.** All decisions D1–D8 are closed. 9 PRs merged today (ADR-0026 all 5 phases + ADMIN-3a/3b/3c). The remaining gap to alpha is **staging + verification, not more code.**

Owners: Prakash (TL/PM, staging+infra), Divyanshu (backend/AI), Rishi Ojha (Android/Flutter), QA.

---

## Phase 0 — Stabilize build  ·  ~92% (near done)  ·  Owner: Divyanshu/Prakash
- **Goal:** branch green, no open IDOR, tree clean.
- **Done:** `lint`/`typecheck`/`test`/`build` green; ADMIN-3a/3b/3c merged; ADR-0026 all phases merged (scrypt PIN — D7 resolved); D7 conflict closed on the safe default.
- **Remaining:** posting-plans guard PR (D3, in progress); run e2e locally on scoop PG+Redis; remove stray root `DB_COMPARE*.md`; reconcile schema "30 vs 32 tables" doc; land the 4 PR-#168 PIN throttle fast-follows before real-SMS.
- **Acceptance:** posting-plans guarded + tests; e2e green locally.
- **Test gate:** full CI parity locally + e2e against PG+Redis.
- **Target:** this week (folds into the B1 sprint).

## Phase 1 — Alpha-gate verification (B1 sprint)  ·  ~10%  ·  Owner: Prakash + Rishi + Divyanshu  ·  **Target: Fri 2026-07-04**
- **Goal:** prove every alpha flow on real infra — the 6 alpha-gate scripts in [TEST_MATRIX.md](TEST_MATRIX.md); close B1 (NO-GO → GO).
- **In scope (decisions all closed):** D1 staging (AWS Lightsail/EC2) + `staging` GitHub Environment + secrets → CD fires → `/health` 200; D2 real OTP (Fast2SMS + ZeptoMail, capped, team allowlist); D5 resume PDF (`RESUME_RENDER_ENABLED=true` + WeasyPrint); B1 handset onboarding→chat→profile→resume **PDF**; payer company gate; agency demand gate; OTP safety gate; RBAC gate; admin ops smoke.
- **Out of scope:** real money; learned ranking; production legal copy; payer PIN unlock (`PAYER-PIN-1` held).
- **Day-by-day (Mon–Fri):**
  - **Mon–Tue** — Prakash: provision Lightsail/EC2 → Docker + WeasyPrint → GitHub Environment + secrets → CD fires → `/health` 200; run migrations (now 31, incl. ADR-0026 tables).
  - **Tue** — Prakash/DevOps: activate OTP-7 (capped) → real OTP send verified (team recipients only).
  - **Wed** — Rishi: real-handset REAL-mode build against staging API → onboarding → chat → profile → **resume PDF** download.
  - **Thu** — QA/Prakash: payer company gate + agency gate on staging; admin ops smoke (3a/3b/3c).
  - **Fri** — QA: all 6 alpha-gate scripts pass with evidence → **B1 CLOSED**.
- **Blockers:** P0 staging not yet provisioned (decided, implementation pending); posting-plans guard (D3, finish in Phase 0).
- **Acceptance:** all 6 scripts pass with the 3 B1 evidence artifacts (screenshots + staging `events` chain + clean logcat).
- **Test gate:** staging `/health` 200 + smoke; manual click-throughs logged in [QA_EVIDENCE.md](QA_EVIDENCE.md).

## Phase 2 — Internal RVM pilot  ·  Owner: Prakash  ·  Target: week of 2026-07-07
- **Goal:** the RVM team uses the system on staging (synthetic + a few real internal users).
- **In scope:** team-restricted staging, real OTP (capped), bug-bash, observability check; land the PR-#168 PIN throttle fast-follows before exposing PIN to real handsets.
- **Out of scope:** external employers/workers; payments.
- **Acceptance:** an internal user completes worker onboarding + a payer posts/unlocks (mock credits) without a Sev-1.
- **Test gate:** observability runbook; events flowing; no PII in logs.

## Phase 3 — Employer / payer alpha  ·  Owner: Prakash + Divyanshu
- **Goal:** a handful of real employers/agencies self-serve on staging.
- **In scope:** payer signup→post→applicants→unlock/reveal (mock credits); capacity; **close LC-1 (PayerAuthGuard on all money routes, D3a)**; the payer-web go-live waves ([PAYER_WEB_GO_LIVE_PLAN.md](PAYER_WEB_GO_LIVE_PLAN.md)) — masked-resume + account-edit wiring (Wave 0), posting pause/resume + quota + payer-authed plan/boost (Wave 1), credit-ledger (Wave 2).
- **Out of scope:** real payments/payouts; KYC.
- **Blockers:** LC-1; capacity-enforcement decision.
- **Acceptance:** external payer completes the loop; no IDOR; faceless boundary holds.
- **Test gate:** security-review on payer surface; agency no-PII tests green.

## Phase 4 — Worker app alpha  ·  Owner: Rishi (Flutter)
- **Goal:** real workers complete profiling→resume on handsets; returning workers unlock via PIN (no re-OTP).
- **In scope:** real OTP, consent, chat, profile, resume **PDF**; device-bound PIN + persistent session (ADR-0026, merged) once the throttle fast-follows land.
- **Out of scope:** voice/STT; notifications backend; job-detail real PII (needs ADR); settings delete UI.
- **Blockers:** Phase 1 B1; real LLM extraction flip (gated, validated 95%); PR-#168 PIN fast-follows before PIN on real handsets.
- **Acceptance:** N real workers onboard end-to-end; PIN unlock works; PII hygiene verified.
- **Test gate:** handset run evidence; no raw PII to LLM/events/logs.

## Phase 5 — Agency demand alpha  ·  Owner: Prakash
- **Goal:** agencies create demand + invite supply (faceless), no payouts.
- **In scope:** agency jobs CRUD, invites (mock WhatsApp/opaque codes), referrals (k-anon); wire worker→invite attribution (currently inert).
- **Out of scope:** payouts, rev-share, KYC, bulk upload (all PARKED).
- **Acceptance:** agency loop works; `assertNoAgencyPII` holds end-to-end.
- **Test gate:** agency-seam + no-PII suites green on staging.

## Phase 6 — Production hardening  ·  Owner: DevOps + database-architect
- **Goal:** production-grade safety.
- **In scope:** finalize RLS (D6 deferral ends here); CORS allow-list (TD30); trust-proxy (TD25); secrets manager / KMS + Argon2id (TD55); voice transcript encryption (R12/TD49); DR plan; cost doc; flip security-scan to blocking; production DPDP legal copy; account-deletion prod endpoint (§7-deferred); voice-audio DSAR erase wiring.
- **Out of scope:** new features.
- **Acceptance:** RLS enforced; DR rehearsed; security-scan blocking & clean.
- **Test gate:** RLS regression tests; rollback rehearsal ([rollback-guide.md](../rollback-guide.md)).

## Phase 7 — Paid launch / scale  ·  Owner: Founder + team
- **Goal:** real money + real providers at scale.
- **In scope:** real payments (Razorpay), real WhatsApp/STT, payouts/KYC (Phase-2 ADRs), learned ranking (deferred), payer PIN unlock (`PAYER-PIN-1`, after amendment).
- **Blockers:** legal, compliance, spend approvals.
- **Acceptance:** real transaction with reconciliation; scalability check.
- **Test gate:** load + payment reconciliation + compliance sign-off.

---
_Roadmap is gated, not dated-first: a phase starts only when the prior phase's test gate is green with evidence. The one hard date is the alpha B1 sprint — **2026-07-04**._
