# Roadmap — now → paid launch

Each phase: goal · in-scope · out-of-scope · blockers · acceptance · **test gate** · owner · target.

> **⚠️ STALE POINTER (2026-07-23):** the "as of" line below and its PR/migration counts are pinned
> to 2026-07-18 (#408) and have not been walked forward through the ~100 PRs since (#409–#508) —
> that walk is NOT done here (would require re-auditing milestones/blockers this session hasn't
> reviewed). Verified-current facts only: `main` HEAD is `ed3c872` (#508, 2026-07-23, 0 open PRs),
> **49 migrations** (0000–0048), **34 ADRs** (0022 now has 2 amendments). Newest work is logged in
> [DAILY_TRACKER.md](DAILY_TRACKER.md) (top entry). A full milestone re-walk is owed, not done here.

## ⏱️ DEADLINE TRACKER — as of 2026-07-18 (`main` @ `085e2f6`, #408)

| Milestone | Target | Status | Slip |
| --------- | ------ | ------ | ---- |
| D1 staging decision (Lightsail/EC2) | 2026-06-29 | ✅ decided | — |
| **Alpha B1 gate** (6 scripts + evidence) | **Fri 2026-07-04** | 🔴 **NOT MET** | **+14 days** |
| Phase 2 — internal RVM pilot | week of 2026-07-07 | 🔴 not started (gated on B1) | **+11 days** |
| Phases 3–7 | ungated dates | not started | — |

**The schedule has been governed by ONE owner-only task for 19 days** (decided 06-29). Everything
else has kept shipping around it: **~66 PRs since 07-16 alone** (#340→#408), 45 migrations, 34 ADRs.

**What genuinely changed — the P0 narrowed from "no pipeline" to "no secrets":**
the CD pipeline is now **BUILT, hardened and verified GREEN** (CD-0..CD-5, CD-1/#383, CD-1a/#386,
CD-1b/#384 — ephemeral `GITHUB_TOKEN` login verified live, env→box secret bridge working,
`environment: staging` gate). Building it also **exposed that the box was never really deployed**:
[R29](../registers/risks-register.md) — `GHCR_PAT` empty, so **every deploy reported SUCCESS while the
image pull failed** (box runs an unknown-vintage image); [R27](../registers/risks-register.md) — the box
booted on **public dev secrets** + a throwaway Postgres (**treat every session/PII minted there as
compromised**). Both are now fail-loud instead of false-green.

### The remaining critical path (strictly ordered — steps 1–3 are owner-only, non-delegable)
1. **STAGING-SECRETS-1** — real secrets into the `staging` GitHub Environment (generated fresh, never
   from `.env`). Include `CORS_ALLOWED_ORIGINS` ([TD72(a)](../registers/tech-debt-register.md) — otherwise
   the first green deploy silently blocks every browser call while `/health` reports healthy).
2. **Apply migrations `0042` + `0043` BEFORE deploying** — both are named by their writers/readers;
   deploying without them breaks extraction INSERTs (0042) and *every* credit purchase + history read (0043).
3. **Triage the R27 box** — stop the dev-secret api + throwaway Postgres; decide the volume's fate.
4. Deploy → `/health` 200 *(note: `/health` gates **connectivity only** — an unmigrated DB still 200s, hence step 2)*.
5. **OTP-7** — Fast2SMS creds + team allowlist. **No mock path exists**; without this nobody can log in.
6. **B1 handset run** (Rishi) → 4 evidence artifacts → `docs/qa/evidence/staging/`.

**Realistic re-forecast:** steps 1–4 are ~half a day of owner work; OTP-7 depends on procuring creds.
**If SECRETS-1 lands 07-18 → B1 closes ~07-21/22.** Every day it slips moves alpha one-for-one.

> ⚠️ **Two things will make staging lie to you even after it goes green:**
> **[TD81](../registers/tech-debt-register.md)** — the `ai-service` is **not in the compose file at all**, so
> the API degrades to mocked AI and `/health` still returns 200: anyone "testing real profiling on staging"
> is testing the mock with no signal saying so. **[R30](../registers/risks-register.md)** is **OPEN** and gates
> `AI_ENABLE_REAL_CALLS` (a word-split phone bypasses the pseudonymize gateway — open by design, since a
> proximity net would destroy real salary data).

---

**Current position (2026-07-18):** `main` @ `085e2f6` (#408). **45 migrations** (0000–0044; **0042+0043 apply-before-deploy**), **34 ADRs** (0001–0033). Since 07-16: the **context-drift register was executed** — ten owner rulings on 07-17 → ADR-0033 (skills-overlap factor at .15, the 06-19 CEO weight ledger now operative), B-3 consent gate on `/resume/generate` (#385), B-4/B-5 location split + one-ask-per-turn (#392), B-6 taxonomy version stamp (#388), D-1 salary carve-out (#392), D-2 chunked async STT (#395), D-3 gated test-login + **staging-smoke rewritten** (#391), D-6 live pricing catalog (#393); plus ADR-0031 deletion grace (#400), ADR-0032 profile photo (#340), TD53 real job surface (#389). A **real pseudonymize phone leak** (Devanagari danda) was found post-merge and closed (#397).

**Prior position (2026-07-15):** ADR-0030 TAX program **P1+P2 COMPLETE** (#211–#230): shared skill id space live on BOTH worker + job sides (mock-default, flag-gated), REAL 76/76 vector backfill done, floor calibrated 0.75, résumé guard locked, and the **TAX-7 growth loop merged (#230)** — unresolved phrases cluster into human-gated proposals (report-only; ratification = only activation path). **TAX-9 merged too (#232) — the ADR-0030 TAX series is COMPLETE (TAX-0..9).** 40 migrations (0000–0039, **all applied** — owner applied 0039 manually 2026-07-15). Owner queue: ratification Q-A/Q-B · SR-1 step-7 env · Q14.

**Prior position (2026-07-14):** Overall **~75%** · Alpha **~58%** · Release **~29%** (unchanged — no new staging/handset evidence). Since Jul 9: #193–#218 merged — payer-web all-seams-live, voice pipeline (ADR-0029, mock), throttle residuals, worker-app kPersistentAuth ON (#201, TD62 open), AI cost/persona series (#203–#210), **ADR-0030 skills taxonomy TAX-0..4 (#211–#215) + roadmap (#217)**, CI-1 action bumps (#218); fork-B runner PR #219 in review. `origin/main` HEAD: `5f4a274` (Jul 14). **38 migrations (0000–0037, applied)**. Decisions D1–**D10** closed.
> 🚨 **DEADLINE SLIPPED — 14 days.** Alpha B1 was **2026-07-04**. As of **2026-07-18** there is still no
> `docs/qa/evidence/staging/` — no `/health` proof, no events chain, no logcat, no PDF. Gap to alpha =
> **100% staging, 0% code** (FE wiring closed by #194; the drift backlog closed 07-17). The critical path
> is now **STAGING-SECRETS-1 → apply 0042+0043 → triage the R27 box → deploy → OTP-7 → B1**, and its first
> three steps are owner-only.

Owners: Prakash (TL/PM, staging+infra), Divyanshu (backend/AI), Rishi Ojha (Android/Flutter), QA.

---

## Phase 0 — Stabilize build  ·  ~92% (near done)  ·  Owner: Divyanshu/Prakash
- **Goal:** branch green, no open IDOR, tree clean.
- **Done:** `lint`/`typecheck`/`test`/`build` green; ADMIN-3a/3b/3c merged; ADR-0026 all phases merged (scrypt PIN — D7 resolved); D7 conflict closed on the safe default.
- **Remaining:** posting-plans guard PR (D3, in progress); run e2e locally on scoop PG+Redis; remove stray root `DB_COMPARE*.md`; reconcile schema "30 vs 32 tables" doc; land the 4 PR-#168 PIN throttle fast-follows before real-SMS.
- **Acceptance:** posting-plans guarded + tests; e2e green locally.
- **Test gate:** full CI parity locally + e2e against PG+Redis.
- **Target:** this week (folds into the B1 sprint).

## Phase 1 — Alpha-gate verification (B1 sprint)  ·  ~15%  ·  Owner: Prakash + Rishi + Divyanshu  ·  ~~**Target: Fri 2026-07-04**~~ **MISSED (+14d) — re-forecast ~2026-07-21/22 if SECRETS-1 lands 07-18**
- **Goal:** prove every alpha flow on real infra — the 6 alpha-gate scripts in [TEST_MATRIX.md](TEST_MATRIX.md); close B1 (NO-GO → GO).
- **In scope (decisions all closed):** D1 staging (AWS Lightsail/EC2) + `staging` GitHub Environment + secrets → CD fires → `/health` 200; D2 real OTP (Fast2SMS + ZeptoMail, capped, team allowlist); D5 resume PDF (`RESUME_RENDER_ENABLED=true` + WeasyPrint); B1 handset onboarding→chat→profile→resume **PDF**; payer company gate; agency demand gate; OTP safety gate; RBAC gate; admin ops smoke.
- **Out of scope:** real money; learned ranking; production legal copy; payer PIN unlock (`PAYER-PIN-1` held).
- **Remaining path (re-cut 2026-07-18 — the old Mon–Fri block is obsolete: the box + CD pipeline now EXIST and the deploy is verified green; what's left is secrets, schema and creds):**
  - **D+0 — Prakash (owner-only, ~half a day):** ① **STAGING-SECRETS-1** — real secrets into the `staging` GitHub Environment, generated fresh (never from `.env`), incl. `CORS_ALLOWED_ORIGINS` (TD72(a)). ② **Apply `0042` then `0043`** — apply-before-deploy; deploying without them breaks extraction INSERTs and every credit purchase. ③ **Triage the R27 box** — stop the dev-secret api + throwaway Postgres; everything minted there is compromised. ④ Deploy → `/health` 200 (connectivity only — hence ②). ⑤ Decide `PAYER_LOGIN_METHOD` (base dev value is MOCK `whatsapp` → payer login is DEAD on the box until pinned) and wire resume storage (`RESUME_RENDER_ENABLED=true` + Supabase creds) or the D5 PDF stays off.
  - **D+1 — Prakash/DevOps:** activate **OTP-7** (Fast2SMS creds, capped, team allowlist). **No mock path exists** — without this nobody can log in, incl. Rishi.
  - **D+1/2 — Rishi:** REAL-mode handset build against the staging API → onboarding → chat → profile → **resume PDF** → 4 evidence artifacts.
  - **D+2 — QA/Prakash:** payer company gate + agency gate on staging; admin ops smoke (3a/3b/3c).
  - **D+3 — QA:** all 6 alpha-gate scripts pass with evidence → **B1 CLOSED**.
- **Blockers:** **STAGING-SECRETS-1** (owner-only, non-delegable) is the single gate; then OTP-7 creds. ⚠️ Even once green, **[TD81](../registers/tech-debt-register.md)** means the `ai-service` is not deployed at all — staging runs **mocked AI while reporting healthy**, so "real profiling verified on staging" is not provable until that's settled (deploy it, or make the mock LOUD in `/health`).
- **Acceptance:** all 6 scripts pass with the 3 B1 evidence families (screenshots + staging `events` chain + clean logcat) plus PDF-open proof (`resume.downloaded`) because D5 requires PDF for alpha.
- **Test gate:** staging `/health` 200 + smoke; manual artifacts stored in [`docs/qa/evidence/`](../qa/evidence/) and indexed in [QA_EVIDENCE.md](QA_EVIDENCE.md).

## Phase 2 — Internal RVM pilot  ·  Owner: Prakash  ·  ~~Target: week of 2026-07-07~~ **SLIPPED (+11d) — starts on B1 close (~07-22+)**
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
