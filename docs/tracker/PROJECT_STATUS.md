# BadaBhai Project Progress

**Last updated:** 2026-07-18 (**B1 CLOSED by owner attestation** — staging live; blocker state reconciled against [BLOCKERS.md](BLOCKERS.md) `86b4f6e`)
**Updated by:** Control-room (blocker reconciliation) · prior full evidence audit 2026-07-10
**Branch:** `origin/main` (HEAD: `f321b6e`, 2026-07-18 — worker-app #464/#465/#456/#462/#336, PR #470)
**Environment:** **Staging LIVE since 2026-07-18** (`0042`+`0043` applied, R27 triaged, **real OTP via Fast2SMS**). Confidence basis = static + unit tests + **60 emulator screenshots (local backend, 2026-07-09 — audited, [QA_EVIDENCE 2026-07-10](QA_EVIDENCE.md))** + **an owner attestation of the staging run**. ⚠️ **Still zero captured staging artifacts:** `docs/qa/evidence/staging/` does not exist — no per-screen screenshots, no exported events chain, no clean logcat. B1 rests on attestation, not files (standing **P2**, BLOCKERS.md).

> **Numbers are evidence-based and conservative.** Cap rule: **no area exceeds 85%** until staging + handset proof exists. Phase weights = CLAUDE.md/owner defaults.
>
> **The percentages below are as of the 2026-07-10 re-score and were NOT re-scored on 2026-07-18.**
> This pass reconciled **blocker state only** (B1/P0), because that is what had gone
> actively wrong: this file was still printing "NO-GO on B1" eight days after B1 closed.
> A real re-score is owed once the staging gates actually run — see the note under
> "Overall Progress".

> ### ⚠️ Read before trusting "B1 CLOSED"
>
> **B1 closed by OWNER ATTESTATION, not by evidence artifacts.** Attested 2026-07-18
> (commit `86b4f6e`): staging live, `0042`+`0043` applied, R27 triaged, real OTP (Fast2SMS),
> **resume download verified**. The three required artifacts — (a) per-screen screenshots,
> (b) the staging `events` chain for the run's `worker_id`, (c) clean logcat — were **never
> captured**. No one but the attesting owner can re-check this today.
>
> **Two things this closure does NOT establish:**
> 1. **Swipe device-verify (feed/apply/skip on a handset) is UNKNOWN.** The attestation names
>    OTP and resume download and never mentions it. Do not record it as verified.
> 2. **The stack is not verified end-to-end.** **[TD81](../registers/tech-debt-register.md)** /
>    issue [#453](https://github.com/badabhai/badabhai-platform/issues/453): the `ai-service` is
>    **absent from [`docker-compose.yml`](../../docker-compose.yml)**, so staging **chat and
>    profile-extraction run silently MOCKED while `/health` returns 200**. That is the exact
>    middle of the chain B1 was designed to prove — the attested span (OTP at one end, resume
>    download at the other) brackets it rather than covering it. **Alpha GO did not arrive with
>    B1; the critical path moved to TD81 + the four unrun staging gates.**
>
> **Migration drift (noted, not resolved):** the attestation names `0042`+`0043`, but the repo
> carries through **`0046`** (`0044` dated 2026-07-17 — *before* the attestation; `0045`/`0046`
> same day as it). **The staging migration level above `0043` is UNKNOWN.** Owner-verify.

## BadaBhai Progress Snapshot (scores 2026-07-10 · blockers 2026-07-18)
- **Overall Project: 75%** · **Alpha Readiness: 58%** · **Release Readiness: 29%**
- Payer Web 78% · Worker App 69% · Backend/API 84% · OTP/Auth/Security 80% · Agency Demand 70% · Resume+Kit 75% · Infra/Staging 45% · Docs/Process 85%
- _Re-score driver (since 72% on Jun 29): 16 PRs merged — A-batch fixes (#173–#176), B-batch backend (#177–#180), B5 org-tenancy (#182–#186, ADR-0027), AI-service retry storm fixed (#187, ADR-0028). LC-1 closed for money routes (#179). Backend 80→84, Payer Web 74→78, OTP/Auth 78→80, Agency 68→70, AI-service 75→80, Docs 80→85. **Jul 10:** PR #189 (worker-app A1/A3/A4 wiring + NEW Flutter payer-app) + PR #190 (60-screenshot evidence refresh) → Worker App 67→69 (evidence: [QA_EVIDENCE 2026-07-10](QA_EVIDENCE.md)). **Infra/Staging unchanged (45%) — staging not deployed, slipped past deadline.**_ ~~(that last clause was true on 2026-07-10; **staging went live 2026-07-18** — the 45% is held for lack of gate runs, not for lack of a box)~~
- **P0 Blockers: 0** — ✅ **CLEARED 2026-07-18.** Staging provisioned; **B1 CLOSED (owner-attested, artifacts uncaptured)**. Was open 19 days; cost 14 days of schedule. **New critical path is P1, not P0:** [TD81](../registers/tech-debt-register.md)/[#453](https://github.com/badabhai/badabhai-platform/issues/453) (staging AI silently mocked behind a 200 `/health`) + alpha gates 1/2/4/5 never run on the real stack.
- **P1 Blockers: 3** — raised from 1 on 2026-07-18, because clearing P0 promoted the work the P0 line above already names. The old count predated that and contradicted it within two lines.
  1. **TD81 / [#453](https://github.com/badabhai/badabhai-platform/issues/453)** — staging runs **mocked AI behind a 200 `/health`**. This is first: it silently weakens every profiling-path claim made against staging, including B1's own event-chain evidence.
  2. **Alpha gates 1/2/4/5 never run on the real stack** (payer-company, agency, RBAC/admin smoke, the OTP-safety half of gate 4). Not failures — *unrun*, which is not the same as passing.
  3. **Ops-internal unlock surface retire** — the ops [`unlocks.controller.ts`](../../apps/api/src/unlocks/unlocks.controller.ts) keeps `InternalServiceGuard` as a deliberate safe-interim (TD33/TD50), blocked on ADMIN-4..8. **Not** payer-facing, **not** called by payer-web — the mildest of the three, kept last on purpose.
  - ⚠️ **Correction (2026-07-16):** the previous "unlock/reveal LC-1 — InternalServiceGuard + body payer_id still open" entry was a **PHANTOM** — it conflated the *ops* controller with the *payer* one. **LC-1 is CLOSED on the payer surface**: [`payer-unlocks.controller.ts:40-41`](../../apps/api/src/payer-portal/payer-unlocks.controller.ts) puts the **whole class** behind `PayerAuthGuard` with `payer_id` from the session (XB-A), and reveal enforces ownership at the chokepoint. CLAUDE.md §8 has it right. The same phantom appears in the 2026-07-14 context doc §11 — see [context-drift-2026-07-16.md](../registers/context-drift-2026-07-16.md).
- **Decisions Needed: 1** — D1–D8 all closed, but **TD81 is an open OWNER DECISION**: deploy the `ai-service` into staging compose, **or** accept mocked-AI staging and make it **LOUD** in `/health`. Settle it before anyone validates real profiling on staging. **Alpha target now 2026-08-15** (soft launch Sep); the 2026-07-04 date slipped 14 days on staging.

**Build health (last full re-verify: `origin/main` `085e2f6` / #408 — per [BLOCKERS.md](BLOCKERS.md)):** `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm test` ✅ (**2,465 tests / 23 tasks**) · `pnpm build` ✅. AI-service: `ruff` ✅ · `pytest` ✅. **The branch is green.** **47 migrations in-repo (0000–0046);** staging is attested at `0043` — **`0044`–`0046` unconfirmed on the box** (see the migration-drift note above).

**What this means:** the codebase is **broad, green, and well-tested at the unit level**, and as of
2026-07-18 **one flow — the worker core path — has an owner's word that it ran on real staging**
(real OTP + resume download). Everything else on the box is still **unproven**: the four alpha
gates (payer-company, agency, OTP-safety half, RBAC/admin smoke) have never been run there, and
under TD81 the AI half of the worker flow was **answered by a mock**. The gap to alpha remains
**verification + staging**, not "more code" — with the added twist that staging now *looks*
healthy while silently mocking AI, which is a worse failure mode than being visibly down.

---

## Overall Progress

> **Percentages are the 2026-07-10 re-score, carried forward unchanged.** Only the Status /
> Blockers / Evidence columns were reconciled on 2026-07-18. Deliberately **not** re-scored
> upward on B1's closure: an attestation with no artifacts, over a stack whose AI leg is mocked,
> does not justify moving numbers. **Next re-score: after the four staging gates run and
> `docs/qa/evidence/staging/` exists.**

| Area | Progress | Status | Confidence | P0/P1 Blockers | Evidence |
| ---- | -------: | ------ | ---------- | -------------- | -------- |
| Overall Project | 75% | IN_PROGRESS | Medium | **0 P0** / several P1 | gates green; 60 audited emulator screenshots (local backend); staging live 2026-07-18 but **attested, not evidenced** |
| Alpha Readiness | 58% | **IN_PROGRESS** (was BLOCKED) | **Low-Medium** | 0 P0 · **P1: TD81** (staging AI silently mocked, [#453](https://github.com/badabhai/badabhai-platform/issues/453)) + gates 1/2/4/5 unrun | **B1 CLOSED 2026-07-18 — owner attestation only** (real OTP + resume download). ❌ `docs/qa/evidence/staging/` absent: no screenshots, no events chain, no logcat. ❓ **Swipe device-verify UNKNOWN** — not in the attestation. **B1 closing ≠ alpha GO** |
| Release Readiness | 29% | BLOCKED | High | RLS deferred, real providers off, no DR/cost doc; ops unlock retire (TD33/TD50) — **payer LC-1 is CLOSED** | [RELEASE_READINESS.md](RELEASE_READINESS.md) |

## Phase Progress (weights = CLAUDE.md/owner defaults, WEIGHTS_PENDING)

| Phase | Weight | Progress | Weighted | Status | Owner (proposed) | Top Blocker |
| ----- | -----: | -------: | -------: | ------ | ---------------- | ----------- |
| Payer Web Alpha | 25% | 78% | 19.5 | VERIFY | Prakash / Divyanshu | No staging run; FE wiring (FE-1..FE-7) in progress; B5 Team wired (#186) |
| Worker App Alpha | 20% | 69% | 13.8 | **VERIFY** (was BLOCKED) | Rishi (Flutter) | **B1 unblocked + closed by attestation 2026-07-18**; PDF download handset-verified 2026-07-17 (PR #256, `USE_MOCKS=true` — real signed-URL fetch still unproven). Residual: no logcat/events artifacts; **swipe device-verify UNKNOWN**; chat/extraction on staging are mocked (TD81) |
| Backend/API/Event | 20% | 84% | 16.8 | VERIFY | Divyanshu | **LC-1 CLOSED on the payer surface** (plan/boost #179; unlock/reveal `PayerAuthGuard` per #110/#119); residual = ops-internal retire (TD33/TD50); B5 org API merged |
| OTP/Auth/Security | 10% | 80% | 8.0 | VERIFY | Divyanshu | PIN throttle hardened (#175); consent-on-resume (#176); real-send unproven on staging |
| Agency Demand Alpha | 10% | 70% | 7.0 | VERIFY | Prakash | B5 payer invites (#185) merged; no staging run |
| Resume + Interview Kit | 7% | 75% | 5.25 | VERIFY | Divyanshu | PDF requires `RESUME_RENDER_ENABLED=true` + WeasyPrint on staging (D5) |
| Infra/Staging/Release | 5% | 45% | 2.25 | **IN_PROGRESS** (was BLOCKED) | Prakash | ✅ **Staging LIVE 2026-07-18** (P0 cleared, 14-day slip). **New P1: TD81** — `ai-service` absent from compose, so the box serves **mocked AI behind a 200 `/health`**. Score held at 45% pending gate runs + artifacts |
| Docs/Tracker/Process | 3% | 85% | 2.55 | IN_PROGRESS | TPM | ADR-0027 (#181) + ADR-0028 (#188) added; tracker updated |
| **TOTAL** | **100%** | **75%** | **75.15** | | | |

## Main Task Progress

### Payer Web Alpha (78%)
| Main Task | Progress | Status | Evidence | Next Action |
| --------- | -------: | ------ | -------- | ----------- |
| Login / OTP (email) | 80% | VERIFY | `login/` real provider; tests; OTP real-only | Prove real ZeptoMail send (staging, OTP-7) |
| Dashboard (role-aware) | 82% | VERIFY | `dashboard/page.tsx` live credits/unlocks/postings; tests | Click-through on staging |
| Post Job | 82% | VERIFY | `postings/new` → live `POST /payer/job-postings`; tests | Staging persist check |
| Manage Postings — pause/resume | 78% | VERIFY | `POST /payer/job-postings/:id/pause|resume` merged #178; FE wiring = **FE-2** | Wire FE seam (pending FE wiring batch) |
| Manage Postings — quota top-up | 78% | VERIFY | `POST /payer/job-postings/:id/quota` merged #180; FE wiring = **FE-4** | Wire FE seam (pending) |
| Plan / Boost | 70% | PARTIAL | `POST /payer/job-postings/:id/plan|boost` merged #179 (LC-1 closed, payer-authed); **net-new UI needed = FE-3** | Build seam fn + UI |
| Applicant Feed | 82% | VERIFY | live `reach/applicants`; faceless; tests | Staging click-through |
| Unlock / Reveal | 80% | VERIFY | masked-resume `POST /payer/resume-disclosures` live; **FE mock seams CLOSED by #194**; unlock/reveal payer-authed (`PayerAuthGuard`, session `payer_id`) | Staging verify |
| Wallet / Credits | 75% | PARTIAL | balance live; `GET /payer/credits/ledger` merged #177; FE still mock = **FE-5** | Wire FE-5 |
| Capacity | 70% | PARTIAL | live buy (mock money); enforcement INERT | Confirm enforcement plan |
| Team / Org RBAC | 78% | VERIFY | B5.1–B5.5 all merged (#182–#186, ADR-0027); payer-web Team page wired (#186) | Staging click-through; account-edit (PROFILE-4) |
| Account / Profile | 55% | PARTIAL | read live; `PATCH /payer/me` live; FE edit wiring = **FE-account** | Wire account edit |

### Worker App Alpha (69%) — **B1 CLOSED 2026-07-18 (owner-attested; artifacts NOT captured)**

> "Next Action: Handset run" in the rows below is **partially satisfied** by the attested
> 2026-07-18 staging run, which enumerated **OTP** and **resume download** only. Rows it did not
> name — chat, profile extraction, swipe — remain **unevidenced**, and for chat/extraction the
> staging box was answering from the **mock** (TD81). Do not tick these off wholesale.
| Main Task | Progress | Status | Evidence | Next Action |
| --------- | -------: | ------ | -------- | ----------- |
| Scaffold + router (ADR-0023) | 85% | VERIFY | `router.dart` go_router stateful shell | Handset run |
| Design tokens (Desi Vernacular Pop) | 85% | VERIFY | `core/theme/*`; no raw hex | DS visual QA |
| Auth / OTP (real-only) | 75% | VERIFY | real `requestOtp/verifyOtp`; 4 tests | Real SMS on handset |
| API client MOCK/REAL toggle | 85% | VERIFY | `app_config.dart` default REAL; mock client | — |
| Onboarding (consent/name/chat) | 78% | VERIFY | real endpoints; tests | Handset flow |
| Profile extraction | 78% | VERIFY | real enqueue+poll; test | Handset + real LLM (gated) |
| Resume gen + download | 78% | VERIFY | real generate/download; tests | Handset PDF download |
| Interview kit | 80% | VERIFY | real public download; tests | Handset |
| Swipe feed + apply/skip | 70% | PARTIAL | feed+apply real; **Applied Jobs list wired to `GET /workers/me/applications` (#189, emulator-proven)**; job-detail = client-side mock synthesis | Real job-detail endpoint (ADR) |
| Profile tab | 45% | PARTIAL | mock-only repo (audit: shows seed persona ≠ logged-in identity) | Real profile-summary endpoint |
| Notifications | 40% | PARTIAL | mock-only (3 canned) | Real signal source |
| Settings | 45% | PARTIAL | **A3 referral + A4 DPDP delete + devices wired real (#189)**; language/WhatsApp rows static | Handset proof |
| Voice note | 10% | PARKED | placeholder; STT deferred (§8) | Do not build (Phase-2) |

### Backend / API / Event Foundation (84%)
| Main Task | Progress | Status | Evidence | Next Action |
| --------- | -------: | ------ | -------- | ----------- |
| Auth/OTP service (breaker+kill-switch) | 82% | VERIFY | `otp.service.ts`; real-only; PII-free logs; tests | Real-send proof |
| Events spine (createEvent + schema) | 85% | VERIFY | `events/`; validated; 1141 api tests green | Staging event flow |
| Job postings API | 82% | VERIFY | `job-postings/`; events; tests | Staging |
| Applications / feed API | 80% | VERIFY | `applications/`; consent-gated; tests | Staging |
| Unlock / reveal API | 85% | VERIFY | payer surface `payer-portal/payer-unlocks.controller.ts` — `PayerAuthGuard`, session `payer_id`, ownership at chokepoint. Ops `unlocks/` keeps `InternalServiceGuard` (deliberate, TD33/TD50) | Retire ops surface (ADMIN-4..8) |
| Credits/wallet + ledger idempotency | 80% | VERIFY | migration 0028; ON CONFLICT DO NOTHING; tests | Staging |
| Capacity / posting-plans API | 82% | VERIFY | InternalServiceGuard added (#174); payer-authed plan/boost merged (#179, LC-1 closed); quota (#180) | Staging verify |
| Agency API | 80% | VERIFY | `agency/`; PayerRoleGuard; payer invites (#185); tests | Staging |
| Payer Org / Team API | 82% | VERIFY | B5.1–B5.5 all merged — payer_orgs + payer_members; PayerOrgRoleGuard; invite accept; real email (gated) | Staging verify; account-edit (PROFILE-4) |
| Admin ops (1/2/3a/3b/3c committed) | 78% | VERIFY | All committed + green; 3c kill-switch (#165) | D4: Prakash owns weekly review; enable 3b once cadence live |
| AI Service — extraction + canonicalization | 80% | VERIFY | Retry storm fixed (#187); Hinglish city aliases; rich→legacy mapper; adjacency flag (ADR-0028) | Staging verify with real LLM (gated) |
| Health (DB+Redis) | 85% | VERIFY | `health/`; no secret leak; tests | Staging probe |

### Worker Auth (ADR-0026) — ALL 5 PHASES MERGED + PIN throttle hardened
Phase 1 (#162) + Phase 2 (#167) + Phase 3 (#168) + Phase 4 (#170) + Phase 5 (#169) — all merged. **PIN throttle hardened (#175 — Jul 1):** cycle-0 flush reset fixed, `/pin/reset` per-IP cap added. **Consent-on-resume (#176 — Jul 1):** defense-in-depth on every session-resume path; WorkerAuthGuard slide/re-mint **LAUNCH-GATED** — must close before `kPersistentAuth` flip. Program rollup **~83%**. **Remaining:** `PAYER-PIN-1` held; account-deletion prod endpoint §7-deferred; real-SMS unproven on staging.

### Payer-Web Go-Live + Android API (backend COMPLETE — Jul 1)
All backend endpoints shipped: A-batch fixes (#173–#176), B-batch (#177–#180), B5 org-tenancy (#182–#186). **LC-1 CLOSED for money routes** (#179). Remaining: **FE wiring batch (FE-1..FE-7)** — switching 5 mock shims to live endpoints; stale "no route yet" comments; drop dead mock-store code. [WEB_ALPHA_TASKS.md](WEB_ALPHA_TASKS.md) is the task board. Android API reference: [../api/payer-agency-api-reference.md](../api/payer-agency-api-reference.md).

### AI Service (ADR-0028 — Jul 8)
Retry storm root cause fixed (#187): transport failures now surface reason code; Hinglish city aliases normalized (dilli→delhi, bihar→patna); rich→legacy canonical mapper + adjacency flag added. **ADR-0028** (international occupation taxonomy — TD56/TD57) accepted (#188). AI-service gates: `ruff` ✅ · `pytest` ✅ · security review PASS (PR #187). **Follow-up (Jul 10):** #187 added `attempt_count`/`candidates_tried`/`failure_reason` to Pydantic `AICallMetadata` without the Zod mirror — parity fix (invariant #7, + `WorkerProfileDraft.canonical_role_id`) staged on `fix/ai-contracts-zod-pydantic-parity`, gates green, pending merge.

### Flutter apps — worker wiring + NEW payer-app (PR #189/#190 — Jul 10)
**PR #189 (client-only):** worker-app wired real for A1 applied-jobs (`GET /workers/me/applications` + apply→applied filter fix), A3 referral invite (HIGH empty-link bug fixed pre-merge), A4 DPDP account-delete, resume reuse on login, error-UX sweep (real failure reasons, never false "check internet"). **NEW `apps/payer-app`** — role-aware Flutter Company + Agency app: 14 screens on Desi Vernacular Pop, `kUseMocks` mock/real seam, REAL bindings written for auth/applicants/unlock/postings/credits/agency/team/capacity; home metrics + referred-workers + payouts + KYC are **design-only** (no backend route). Both apps `flutter analyze`/`test` green.
**PR #190 + audit:** 60 emulator screenshots (2026-07-09 session) replace the 9 JPEGs; all 60 visually audited 2026-07-10 ([QA_EVIDENCE](QA_EVIDENCE.md) + [evidence README](../qa/evidence/README.md)). Verdicts: worker-app **local API wiring proven** (mock-OTP round-trip, identity-bearing resume, applied jobs, referral link); payer-app **mock-mode UI evidence only** (DEBUG/Mock ribbons, static timestamps, credits toast/balance mock bug). **Follow-ups:** payer unlocked-candidate screen shows a raw phone (dummy) — align with ADR-0010 in-app relay before real data; Razorpay copy overstates (payments mock); tester's real phone visible in 4 committed shots — re-shoot masked; PR #189 fast-follows (fetchCredits 0-mask, disclose) open.

## Final Task Progress (selected — full set rolls up above)

| Main Task | Final Task | Progress | Status | Blocker | Evidence | Acceptance |
| --------- | ---------- | -------: | ------ | ------- | -------- | ---------- |
| Login OTP | ZeptoMail email-OTP send | 75% | BLOCKED | Real-send gate (OTP-7) | tests green; no real send | OTP received, no PII in logs |
| Post Job | Live `/payer/job-postings` integration | 82% | VERIFY | None | live + tests | Job persists via live API |
| Unlock/Reveal | Per-payer auth on money route | 100% | **DONE** | — | payer surface rides `PayerAuthGuard`; `payer_id` from session (XB-A) | Verified 2026-07-16 — ops-internal retire (TD33/TD50) is the only residual |
| Posting plans | Guard the `/plan` + `/boost` routes | 50% | IN_PROGRESS | D3 decided (guard) | controller fix in progress | Auth guard + ownership check |
| Admin PII reveal (3b) | Reason-gated reveal committed + green | 78% | VERIFY | D4: cadence must go live | merged green; D4 owner = Prakash (weekly review) | Weekly audit-stream review + 1-yr retention operational |
| Worker app | Handset onboarding->resume on staging | **60%** | **PARTIAL** (was BLOCKED) | **Artifacts uncaptured (P2)**; chat/extraction leg mocked (**TD81**) | **Owner attestation 2026-07-18**: staging live, real OTP, resume download verified. PDF open/save handset-verified 2026-07-17 (PR #256, mock mode). **Still missing all three evidence families** — `docs/qa/evidence/staging/` does not exist | 3 evidence families (screenshots + events + logcat), plus PDF `resume.downloaded`. **Unchanged — the acceptance bar was not met; it was substituted with an attestation** |
| Worker app | Swipe device-verify (feed/apply/skip on handset) | **UNKNOWN** | **UNKNOWN** | Never evidenced | Absent from the 2026-07-18 attestation; no artifact exists. Code is CLOSED (ADR-0009 Stream C) — the **device** run is what is unknown | Handset feed/apply/skip + matching events; rides the next B1 session |
| Credits | Real credit-ledger history read | 50% | PARTIAL | endpoint | UI on mock store | History from live ledger |

---

## Module Classification (DONE / VERIFY / PARTIAL / BROKEN / BLOCKED / PARKED / DEAD / LEGAL_GATE / UNKNOWN)

**VERIFY** (built + unit-tested, needs runtime/staging proof): payer-web login/dashboard/post-job/applicants; backend auth/OTP/events/job-postings/applications/credits/health/agency/admin(1-3b); worker-app auth/consent/name/chat/profile/resume/kit; AI pseudonymization+extraction; design system.

**PARTIAL** (some working, some missing): payer-web manage-postings, unlock/reveal, wallet, capacity, team-RBAC, account (all now live-wired — #194); worker-app swipe(job-detail), notifications, settings; **payer-app (Flutter, #189): UI complete + real bindings written, live seam unverified (screenshots are mock-mode); payouts/KYC/home-metrics design-only**. _(Backend unlock/reveal + posting-plans are payer-authed — the old "LC-1 / unguarded" note here was the phantom; see [context-drift-2026-07-16.md](../registers/context-drift-2026-07-16.md).)_

**BLOCKED:** staging CD (unwired). _(worker-app alpha left this bucket 2026-07-18 — B1 closed by
attestation. It is **VERIFY-with-caveats**, not DONE: no artifacts, swipe unverified, AI mocked.)_

**PARKED (do not build now):** voice/STT, agency payouts/KYC/bulk-upload, learned Reach ranking, real payments/WhatsApp/STT providers, raw-phone reveal, production legal copy, finalized RLS.

**DEAD:** `DEV_QUICK_LOGIN` / dev/mock OTP — **removed** (real-only OTP, commit `d2f228e`). Do not reintroduce.

**LEGAL_GATE:** DPDP production consent copy + erasure policy; real-money payments; real-send OTP activation; **admin PII-reveal operational conditions (R24/OQ-7: weekly review + 1-yr retention).**

**UNKNOWN (needs runtime check):** dark-theme parity completeness; formal WCAG/a11y conformance; e2e suite behaviour against real PG+Redis (only CI-run today); **swipe device-verify (feed/apply/skip on a handset) — never evidenced, absent from the B1 attestation**; **staging migration level above `0043`** (repo carries through `0046`); **whether any staging profiling result to date came from a real LLM or the mock** (TD81 — `/health` cannot currently tell you).

---
_Math: overall = Σ(phase% × weight) = 75.15 → reported 75% (conservative). Re-scored 2026-07-09 after 16 PRs (Jun 30–Jul 8); Worker App 67→69 on 2026-07-10 (PR #189 wiring + 60-screenshot audit). **2026-07-18: blocker state reconciled against [BLOCKERS.md](BLOCKERS.md) (`86b4f6e`) — percentages deliberately NOT moved.** B1 closed on an owner attestation with **zero captured artifacts**, over a staging box whose AI leg is mocked (TD81) — that is not the kind of proof that earns points. **Next re-score after: `docs/qa/evidence/staging/` exists (screenshots + events chain + clean logcat), swipe is device-verified, and TD81 is settled.** The gate is no longer staging-deployment; it is staging **proof**._
