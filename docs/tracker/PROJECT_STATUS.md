# BadaBhai Project Progress

**Last updated:** 2026-07-10 (PR #189 Flutter wiring + NEW payer-app, PR #190 evidence refresh; 60-screenshot audit; Worker App 67→69)
**Updated by:** Control-room (evidence audit + tracker sync)
**Branch:** `origin/main` (HEAD: `905fd1f` — B1 evidence screenshots, Jul 10) · Local: `docs/tracker-sync-and-b1-evidence`
**Environment:** Local (Windows, no Docker). **Staging STILL NOT DEPLOYED — deadline slipped past 2026-07-04.** Confidence basis = static + unit tests + **60 emulator screenshots (local backend, 2026-07-09 session — audited, [QA_EVIDENCE 2026-07-10](QA_EVIDENCE.md))**; **zero staging/handset proof (no /health, no events chain, no logcat, no PDF).**

> **Numbers are evidence-based and conservative.** Cap rule: **no area exceeds 85%** until staging + handset proof exists. Phase weights = CLAUDE.md/owner defaults.

## BadaBhai Progress Snapshot (2026-07-10)
- **Overall Project: 75%** · **Alpha Readiness: 58%** · **Release Readiness: 29%**
- Payer Web 78% · Worker App 69% · Backend/API 84% · OTP/Auth/Security 80% · Agency Demand 70% · Resume+Kit 75% · Infra/Staging 45% · Docs/Process 85%
- _Re-score driver (since 72% on Jun 29): 16 PRs merged — A-batch fixes (#173–#176), B-batch backend (#177–#180), B5 org-tenancy (#182–#186, ADR-0027), AI-service retry storm fixed (#187, ADR-0028). LC-1 closed for money routes (#179). Backend 80→84, Payer Web 74→78, OTP/Auth 78→80, Agency 68→70, AI-service 75→80, Docs 80→85. **Jul 10:** PR #189 (worker-app A1/A3/A4 wiring + NEW Flutter payer-app) + PR #190 (60-screenshot evidence refresh) → Worker App 67→69 (evidence: [QA_EVIDENCE 2026-07-10](QA_EVIDENCE.md)). **Infra/Staging unchanged (45%) — staging not deployed, slipped past deadline.**_
- **P0 Blockers: 1** (staging not provisioned — PAST deadline 2026-07-04, now CRITICAL)
- **P1 Blockers: 1** (unlock/reveal LC-1 — InternalServiceGuard + body payer_id still open; money routes closed by #179)
- **Decisions Needed: 0** — all D1–D8 closed. **Alpha deadline SLIPPED — was 2026-07-04, now targeting ASAP (est. 2026-07-07/08 when staging lands).**

**Build health (re-verified on `origin/main` `a143a7d`):** `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm test` ✅ (1289/1289 api tests, 129 files) · `pnpm build` ✅. AI-service: `ruff` ✅ · `pytest` ✅ (gates green per PR #187). **The branch is green.** 40 migrations (0000–0039; 0039 apply pending — owner; 0038 applied 2026-07-15).

**What this means:** the codebase is **broad, green, and well-tested at the unit level** (api 1141 tests,
payer-web 517, ai-service ~220, worker-app 46 files) but **not one flow is proven on real infrastructure**.
The gap to alpha is **verification + staging**, not "more code".

---

## Overall Progress

| Area | Progress | Status | Confidence | P0/P1 Blockers | Evidence |
| ---- | -------: | ------ | ---------- | -------------- | -------- |
| Overall Project | 75% | IN_PROGRESS | Medium | 1 P0 / 1 P1 | gates green; 18 PRs merged Jun 30–Jul 10; 60 audited emulator screenshots (local backend); no staging/handset proof |
| Alpha Readiness | 58% | BLOCKED | Medium | 1 P0 — staging not deployed, PAST deadline 2026-07-04 | NO-GO on B1; 60 emulator/local screenshots audited (worker wiring real, payer-app mock-mode); still need staging /health + events + logcat + PDF |
| Release Readiness | 29% | BLOCKED | High | RLS deferred, real providers off, no DR/cost doc, unlock/reveal LC-1 open | [RELEASE_READINESS.md](RELEASE_READINESS.md) |

## Phase Progress (weights = CLAUDE.md/owner defaults, WEIGHTS_PENDING)

| Phase | Weight | Progress | Weighted | Status | Owner (proposed) | Top Blocker |
| ----- | -----: | -------: | -------: | ------ | ---------------- | ----------- |
| Payer Web Alpha | 25% | 78% | 19.5 | VERIFY | Prakash / Divyanshu | No staging run; FE wiring (FE-1..FE-7) in progress; B5 Team wired (#186) |
| Worker App Alpha | 20% | 69% | 13.8 | BLOCKED | Rishi (Flutter) | B1 handset (P0 — staging not live); PR #189 wiring merged + emulator-run audit; no PDF/logcat/staging proof |
| Backend/API/Event | 20% | 84% | 16.8 | VERIFY | Divyanshu | LC-1 closed for money routes (#179); unlock/reveal still InternalServiceGuard; B5 org API merged |
| OTP/Auth/Security | 10% | 80% | 8.0 | VERIFY | Divyanshu | PIN throttle hardened (#175); consent-on-resume (#176); real-send unproven on staging |
| Agency Demand Alpha | 10% | 70% | 7.0 | VERIFY | Prakash | B5 payer invites (#185) merged; no staging run |
| Resume + Interview Kit | 7% | 75% | 5.25 | VERIFY | Divyanshu | PDF requires `RESUME_RENDER_ENABLED=true` + WeasyPrint on staging (D5) |
| Infra/Staging/Release | 5% | 45% | 2.25 | BLOCKED | Prakash | **Staging STILL not deployed — PAST deadline. P0 CRITICAL.** |
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
| Unlock / Reveal | 72% | PARTIAL | masked-resume `POST /payer/resume-disclosures` live; FE still mock = **FE-1**; unlock/reveal InternalServiceGuard (LC-1 still open) | Wire FE-1; close LC-1 for unlock/reveal |
| Wallet / Credits | 75% | PARTIAL | balance live; `GET /payer/credits/ledger` merged #177; FE still mock = **FE-5** | Wire FE-5 |
| Capacity | 70% | PARTIAL | live buy (mock money); enforcement INERT | Confirm enforcement plan |
| Team / Org RBAC | 78% | VERIFY | B5.1–B5.5 all merged (#182–#186, ADR-0027); payer-web Team page wired (#186) | Staging click-through; account-edit (PROFILE-4) |
| Account / Profile | 55% | PARTIAL | read live; `PATCH /payer/me` live; FE edit wiring = **FE-account** | Wire account edit |

### Worker App Alpha (69%) — **P0: not yet proven on real staging/handset (B1 PAST DEADLINE)**
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
| Unlock / reveal API | 70% | PARTIAL | `unlocks/`; **InternalServiceGuard + body payer_id (LC-1)** | Close LC-1 |
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
| Unlock/Reveal | Per-payer auth on money route | 40% | BLOCKED | LC-1 (TD33/TD50) | rides InternalServiceGuard | Caller payer_id from session, not body |
| Posting plans | Guard the `/plan` + `/boost` routes | 50% | IN_PROGRESS | D3 decided (guard) | controller fix in progress | Auth guard + ownership check |
| Admin PII reveal (3b) | Reason-gated reveal committed + green | 78% | VERIFY | D4: cadence must go live | merged green; D4 owner = Prakash (weekly review) | Weekly audit-stream review + 1-yr retention operational |
| Worker app | Handset onboarding->resume on staging | 0% | BLOCKED | B1 / staging — **PAST deadline 2026-07-04** | 60 emulator/local screenshots audited (2026-07-10) — still missing staging /health + events + clean logcat + PDF-open proof | 3 evidence families (screenshots + events + logcat), plus PDF `resume.downloaded` |
| Credits | Real credit-ledger history read | 50% | PARTIAL | endpoint | UI on mock store | History from live ledger |

---

## Module Classification (DONE / VERIFY / PARTIAL / BROKEN / BLOCKED / PARKED / DEAD / LEGAL_GATE / UNKNOWN)

**VERIFY** (built + unit-tested, needs runtime/staging proof): payer-web login/dashboard/post-job/applicants; backend auth/OTP/events/job-postings/applications/credits/health/agency/admin(1-3b); worker-app auth/consent/name/chat/profile/resume/kit; AI pseudonymization+extraction; design system.

**PARTIAL** (some working, some missing): payer-web manage-postings, unlock/reveal, wallet, capacity, team-RBAC, account; backend unlock/reveal (LC-1), posting-plans (unguarded); worker-app swipe(job-detail), profile-tab, notifications, settings; **payer-app (Flutter, #189): UI complete + real bindings written, live seam unverified (screenshots are mock-mode); payouts/KYC/home-metrics design-only**.

**BLOCKED:** worker-app alpha (B1 handset/staging); staging CD (unwired).

**PARKED (do not build now):** voice/STT, agency payouts/KYC/bulk-upload, learned Reach ranking, real payments/WhatsApp/STT providers, raw-phone reveal, production legal copy, finalized RLS.

**DEAD:** `DEV_QUICK_LOGIN` / dev/mock OTP — **removed** (real-only OTP, commit `d2f228e`). Do not reintroduce.

**LEGAL_GATE:** DPDP production consent copy + erasure policy; real-money payments; real-send OTP activation; **admin PII-reveal operational conditions (R24/OQ-7: weekly review + 1-yr retention).**

**UNKNOWN (needs runtime check):** dark-theme parity completeness; formal WCAG/a11y conformance; e2e suite behaviour against real PG+Redis (only CI-run today).

---
_Math: overall = Σ(phase% × weight) = 75.15 → reported 75% (conservative; no staging/handset proof). Re-scored 2026-07-09 after 16 PRs (Jun 30–Jul 8); Worker App 67→69 on 2026-07-10 (PR #189 wiring + 60-screenshot audit). Next re-score after staging /health 200 + B1 handset evidence. Staging P0 is the only gate._
