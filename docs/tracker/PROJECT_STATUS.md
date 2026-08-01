# BadaBhai Project Progress

**Last updated:** 2026-08-01 — **PR #526 merged** (Matching V1 / ADR-0036 + B5 agency slice + canary closure). Prior verification state unchanged: **B1 worker capstone verified (Divyanshu)** · **swipe handset verified (Prakash)** · payer company/agency **IN_PROGRESS** (OTP working)
**Updated by:** Divyanshu Pant (verification sign-off, 2026-07-25) + tracker sync (2026-08-01, #526 merge)
**Branch:** `origin/main` (HEAD: `f28279f`, 2026-08-01) — branch protection ENABLED 2026-08-01 (`ci-required` + 1 review, force-push/deletion blocked, `enforce_admins` off)
**Environment:** **Staging LIVE since 2026-07-18** (`0042`+`0043` applied, R27 triaged, **real OTP via Fast2SMS**). Worker B1 + swipe verified 2026-07-25 per [QA_EVIDENCE](QA_EVIDENCE.md). ⚠️ **`docs/qa/evidence/staging/` still empty** — team attestation, not captured files (P2, [BLOCKERS.md](BLOCKERS.md)).

> **Numbers are evidence-based and conservative.** Cap rule: **no area exceeds 85%** until staging + handset proof exists. Phase weights = CLAUDE.md/owner defaults.
>
> **The percentages below are as of the 2026-07-10 re-score and were NOT re-scored on 2026-07-18,
> nor on 2026-08-01.** The 2026-08-01 pass updated the header, the branch HEAD and the #526 merge
> facts ONLY. Nothing in #526 was verified on a deployed environment — it is CI and local
> measurement — so under this file's own cap rule it moves no percentage. Read the numbers as
> three weeks stale, not as of the date at the top.
> This pass reconciled **blocker state only** (B1/P0), because that is what had gone
> actively wrong: this file was still printing "NO-GO on B1" eight days after B1 closed.
> A real re-score is owed once the staging gates actually run — see the note under
> "Overall Progress".

> ### B1 worker capstone — verified 2026-07-25
>
> **Verified by Divyanshu Pant (2026-07-25):** B1 worker capstone (login → consent → profiling path →
> resume) accepted complete for alpha tracking. Supersedes the 2026-07-18 attestation-only label for
> the worker path. Index: [QA_EVIDENCE 2026-07-25](QA_EVIDENCE.md).
>
> **Verified by Prakash Kantumutchu (2026-07-25):** swipe feed / apply / skip on a **real handset**
> (no longer UNKNOWN).
>
> **Payer company + agency (2026-07-25):** **IN_PROGRESS** — **OTP login/send works**; remaining
> gate-1/2 features (post/manage/applicants/unlock/wallet/capacity/plan/boost; agency demand) **not
> yet verified** end-to-end on staging.
>
> **Still open for reproducible proof:** (a) per-screen staging screenshots, (b) exported `events`
> chain, (c) clean logcat — `docs/qa/evidence/staging/` does not exist (P2).
>
> **TD81 / staging AI:** [TD81](../registers/tech-debt-register.md) may still apply for independent
> box re-verification (compose overlay in `docker-compose.staging.yml`); does not retract the
> 2026-07-25 worker sign-offs above.
>
> **Migration drift (noted, not resolved):** staging level above attested **`0043`** may lag repo
> (**through `0049`** as of 2026-07-25). Owner-verify before deploy.

## BadaBhai Progress Snapshot (scores 2026-07-10 · verification 2026-07-25)
- **Overall Project: 75%** · **Alpha Readiness: 58%** · **Release Readiness: 29%**
- Payer Web 78% · Worker App 69% · Backend/API 84% · OTP/Auth/Security 80% · Agency Demand 70% · Resume+Kit 75% · Infra/Staging 45% · Docs/Process 85%
- _Re-score driver (since 72% on Jun 29): 16 PRs merged — A-batch fixes (#173–#176), B-batch backend (#177–#180), B5 org-tenancy (#182–#186, ADR-0027), AI-service retry storm fixed (#187, ADR-0028). LC-1 closed for money routes (#179). Backend 80→84, Payer Web 74→78, OTP/Auth 78→80, Agency 68→70, AI-service 75→80, Docs 80→85. **Jul 10:** PR #189 (worker-app A1/A3/A4 wiring + NEW Flutter payer-app) + PR #190 (60-screenshot evidence refresh) → Worker App 67→69 (evidence: [QA_EVIDENCE 2026-07-10](QA_EVIDENCE.md)). **Infra/Staging unchanged (45%) — staging not deployed, slipped past deadline.**_ ~~(that last clause was true on 2026-07-10; **staging went live 2026-07-18** — the 45% is held for lack of gate runs, not for lack of a box)~~
- **P0 Blockers: 0** — ✅ **CLEARED 2026-07-18.** **B1 worker capstone VERIFIED 2026-07-25 (Divyanshu).** Swipe handset VERIFIED 2026-07-25 (Prakash). **Payer company + agency IN_PROGRESS** (OTP working; rest of gates 1/2 not done). **Critical path:** finish payer gates 1/2 + gates 4/5 + TD81 + staging artifacts.
- **P1 Blockers: 3**
  1. **TD81 / [#453](https://github.com/badabhai/badabhai-platform/issues/453)** — staging AI mock vs real (independent re-proof).
  2. **Alpha gates 1/2 IN_PROGRESS** — OTP verified; full payer-company + agency click-through **not verified** (2026-07-25). Gates 4/5 still unrun.
  3. **Ops-internal unlock surface retire** — ops controller; blocked on ADMIN-4..8 (unchanged).
  - ⚠️ **Correction (2026-07-16):** the previous "unlock/reveal LC-1 — InternalServiceGuard + body payer_id still open" entry was a **PHANTOM** — it conflated the *ops* controller with the *payer* one. **LC-1 is CLOSED on the payer surface**: [`payer-unlocks.controller.ts:40-41`](../../apps/api/src/payer-portal/payer-unlocks.controller.ts) puts the **whole class** behind `PayerAuthGuard` with `payer_id` from the session (XB-A), and reveal enforces ownership at the chokepoint. CLAUDE.md §8 has it right. The same phantom appears in the 2026-07-14 context doc §11 — see [context-drift-2026-07-16.md](../registers/context-drift-2026-07-16.md).
- **Decisions Needed: 1** — D1–D8 all closed, but **TD81 is an open OWNER DECISION**: deploy the `ai-service` into staging compose, **or** accept mocked-AI staging and make it **LOUD** in `/health`. Settle it before anyone validates real profiling on staging. **Alpha target now 2026-08-15** (soft launch Sep); the 2026-07-04 date slipped 14 days on staging.

**Build health (last full re-verify: `origin/main` `085e2f6` / #408 — per [BLOCKERS.md](BLOCKERS.md)):** `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm test` ✅ (**2,465 tests / 23 tasks**) · `pnpm build` ✅. AI-service: `ruff` ✅ · `pytest` ✅. **The branch is green.** **47 migrations in-repo (0000–0046);** staging is attested at `0043` — **`0044`–`0046` unconfirmed on the box** (see the migration-drift note above).

**What this means:** the codebase is **broad, green, and well-tested at the unit level**. As of
**2026-07-25**, the **worker alpha path (B1 + swipe) is team-verified** ([QA_EVIDENCE](QA_EVIDENCE.md)).
**Payer company and agency flows are IN_PROGRESS** — OTP works; full gates 1/2 are not done. Alpha GO
still requires finishing payer gates, gates 4/5, TD81 settlement on the box, and captured staging artifacts.

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
| Alpha Readiness | 58% | **IN_PROGRESS** | **Medium** (worker verified) | 0 P0 · **P1: payer gates 1/2 IN_PROGRESS** (OTP ✅) + TD81 + gates 4/5 | **B1 VERIFIED 2026-07-25 (Divyanshu)** · **swipe VERIFIED (Prakash)** · payer OTP ✅ / rest WIP · artifacts folder still absent |
| Release Readiness | 29% | BLOCKED | High | RLS deferred, real providers off, no DR/cost doc; ops unlock retire (TD33/TD50) — **payer LC-1 is CLOSED** | [RELEASE_READINESS.md](RELEASE_READINESS.md) |

## Phase Progress (weights = CLAUDE.md/owner defaults, WEIGHTS_PENDING)

| Phase | Weight | Progress | Weighted | Status | Owner (proposed) | Top Blocker |
| ----- | -----: | -------: | -------: | ------ | ---------------- | ----------- |
| Payer Web Alpha | 25% | 78% | 19.5 | **IN_PROGRESS** | Prakash / Divyanshu | **OTP working (2026-07-25)**; company gate-1 rest **WIP**; FE/staging click-through outstanding |
| Worker App Alpha | 20% | 69% | 13.8 | **VERIFY** | Rishi (Flutter) | **B1 VERIFIED 2026-07-25 (Divyanshu)** · **swipe handset VERIFIED (Prakash)** · artifact folder still open (P2) |
| Backend/API/Event | 20% | 84% | 16.8 | VERIFY | Divyanshu | **LC-1 CLOSED on the payer surface** (plan/boost #179; unlock/reveal `PayerAuthGuard` per #110/#119); residual = ops-internal retire (TD33/TD50); B5 org API merged |
| OTP/Auth/Security | 10% | 80% | 8.0 | VERIFY | Divyanshu | PIN throttle hardened (#175); consent-on-resume (#176); real-send unproven on staging |
| Agency Demand Alpha | 10% | 70% | 7.0 | **IN_PROGRESS** | Prakash | **OTP working**; agency gate-2 rest **WIP** (2026-07-25) |
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

### Worker App Alpha (69%) — **B1 VERIFIED 2026-07-25 (Divyanshu Pant)**

> Swipe feed/apply/skip **verified on real handset 2026-07-25 (Prakash Kantumutchu)** — see
> [QA_EVIDENCE 2026-07-25](QA_EVIDENCE.md). Staging artifact folder still absent (P2).
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
| Swipe feed + apply/skip | 78% | **VERIFY** | feed+apply real; **handset verified 2026-07-25 (Prakash)**; Applied Jobs wired | — |
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
| Worker app | Handset onboarding->resume on staging | **85%** | **VERIFY** | Artifact folder (P2) | **B1 VERIFIED 2026-07-25 (Divyanshu)** — [QA_EVIDENCE](QA_EVIDENCE.md) | Capstone accepted; capture screenshots + events + logcat when convenient |
| Worker app | Swipe device-verify (feed/apply/skip on handset) | **VERIFIED** | **DONE** | — | **Prakash, real handset 2026-07-25** | Matching events capture still open (P2) |
| Credits | Real credit-ledger history read | 50% | PARTIAL | endpoint | UI on mock store | History from live ledger |

---

## Module Classification (DONE / VERIFY / PARTIAL / BROKEN / BLOCKED / PARKED / DEAD / LEGAL_GATE / UNKNOWN)

**VERIFY** (built + unit-tested, needs runtime/staging proof): payer-web login/dashboard/post-job/applicants; backend auth/OTP/events/job-postings/applications/credits/health/agency/admin(1-3b); worker-app auth/consent/name/chat/profile/resume/kit; AI pseudonymization+extraction; design system.

**PARTIAL** (some working, some missing): payer-web manage-postings, unlock/reveal, wallet, capacity, team-RBAC, account (all now live-wired — #194); worker-app swipe(job-detail), notifications, settings; **payer-app (Flutter, #189): UI complete + real bindings written, live seam unverified (screenshots are mock-mode); payouts/KYC/home-metrics design-only** (this is the Flutter payer-app — distinct from the payer-web agency KYC/payout build below); **agency KYC/payout ledger/earnings (apps/payer-web + apps/api, ADR-0022 Amdt 2, PR #508, 2026-07-23): built + unit-tested (api 1985 + payer-web 602 + web 42 tests, security-reviewed 0 Crit/High) but entirely INERT BY DESIGN — `AGENCY_PAYOUTS_ENABLED` default OFF (every KYC/earnings/payout route neutral-404s), no runtime/staging proof yet, no real money/PII collected**. _(Backend unlock/reveal + posting-plans are payer-authed — the old "LC-1 / unguarded" note here was the phantom; see [context-drift-2026-07-16.md](../registers/context-drift-2026-07-16.md).)_

**BLOCKED:** staging CD (unwired). _(Worker B1 + swipe verified 2026-07-25; payer gates 1/2 IN_PROGRESS.)_

**PARKED (do not build now):** voice/STT, bulk-upload (agency payouts/KYC machinery is now BUILT mock+gated — see PARTIAL above; only its go-live remains gated, per LEGAL_GATE below), learned Reach ranking, real payments/WhatsApp/STT providers, raw-phone reveal, production legal copy, finalized RLS.

**DEAD:** `DEV_QUICK_LOGIN` / dev/mock OTP — **removed** (real-only OTP, commit `d2f228e`). Do not reintroduce.

**LEGAL_GATE:** DPDP production consent copy + erasure policy; real-money payments (incl. agency payout disbursement, §7); real-send OTP activation; legal/DPDP sign-off on **live agency-KYC collection** (financial PII — PAN/bank, ADR-0022 Amdt 2); **admin PII-reveal operational conditions (R24/OQ-7: weekly review + 1-yr retention).**

**UNKNOWN (needs runtime check):** dark-theme parity completeness; formal WCAG/a11y conformance; e2e suite behaviour against real PG+Redis (only CI-run today); **staging migration level above attested `0043`** (repo through `0049`); **whether staging box uses ai-service overlay** (TD81).

---
_Math: overall = Σ(phase% × weight) = 75.15 → reported 75% (conservative). **2026-07-25:** worker B1 + swipe verification recorded ([QA_EVIDENCE](QA_EVIDENCE.md)); payer OTP ✅ / gates 1–2 WIP; percentages not re-scored. **Next re-score after:** payer gates 1/2 complete + `docs/qa/evidence/staging/` exists._
