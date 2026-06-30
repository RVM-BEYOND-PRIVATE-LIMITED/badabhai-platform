# BadaBhai Project Progress

**Last updated:** 2026-06-30 (evidence-folder verification; no percentage move)
**Updated by:** Control-room (evidence verification + 200% daily board)
**Branch:** `main` (HEAD: `2f1de80`) — latest pulled; ADR-0026 all phases + ADMIN-3a/3b/3c + worker Applied Jobs are on main
**Environment:** Local (Windows, no Docker). **Staging deployment pending (D1 decided: Lightsail/EC2).** Confidence basis = static + unit/integration tests plus partial screenshot artifacts in `docs/qa/evidence/b1`; **zero staging event/logcat proof yet.**

> **Numbers are evidence-based and conservative.** Nothing has been verified on real
> infrastructure, so by the honesty rule **no area exceeds 85%**. Phase weights are the
> CLAUDE.md/owner defaults — `WEIGHTS_PENDING` ratification.

## BadaBhai Progress Snapshot (2026-06-29)
- **Overall Project: 72%** · **Alpha Readiness: 57%** · **Release Readiness: 28%**
- Payer Web 74% · Worker App 67% · Backend/API 80% · OTP/Auth/Security 78% · Agency Demand 68% · Resume+Kit 75% · Infra/Staging 45% · Docs/Process 80%
- _Re-score driver (since 69% baseline): ADR-0026 all 5 phases + ADMIN-3a/3b/3c merged -> Worker Auth 35%->80%, lifting Backend 77->80, OTP/Auth 70->78, Worker App 62->67. **Caps unchanged: screenshot artifacts now exist, but there is still 0 staging event/logcat proof -> no area >85%; alpha gated by B1.**_
- **P0 Blockers: 1** (staging not yet provisioned — D1 DECIDED: Lightsail/EC2, Prakash executing)
- **P1 Blockers: 1** (unlock/reveal LC-1 auth — posting-plans D3 DECIDED: guard in progress)
- **Decisions Needed: 0** — all decisions closed 2026-06-29 (D1–D8). **Alpha deadline: Friday 2026-07-04 (B1 sprint).**

**Build health (re-verified `0635aee`):** `pnpm lint` ✅ (0 errors, 1 pre-existing warning) · `pnpm typecheck` ✅ (23/23) · `pnpm test` ✅ · `pnpm build` ✅. **The branch is green.** (Earlier in this audit the tree was transiently red on uncommitted ADMIN-3b WIP — that work is now committed and clean.)

**What this means:** the codebase is **broad, green, and well-tested at the unit level** (api 1141 tests,
payer-web 517, ai-service ~220, worker-app 46 files) but **not one flow is proven on real infrastructure**.
The gap to alpha is **verification + staging**, not "more code".

---

## Overall Progress

| Area | Progress | Status | Confidence | P0/P1 Blockers | Evidence |
| ---- | -------: | ------ | ---------- | -------------- | -------- |
| Overall Project | 72% | IN_PROGRESS | Medium | 1 P0 / 1 P1 | [QA_EVIDENCE.md](QA_EVIDENCE.md) + [`docs/qa/evidence/`](../qa/evidence/) — gates green; screenshots present; no staging event/logcat proof |
| Alpha Readiness | 57% | BLOCKED | Medium | 1 P0 (B1 handset / staging) — B1 sprint → 2026-07-04 | [registers/alpha-capstone-fixlist.md](../registers/alpha-capstone-fixlist.md) — NO-GO on B1; screenshot evidence partial |
| Release Readiness | 28% | BLOCKED | High | RLS deferred, real providers off, no DR/cost doc, 4 PIN throttle fast-follows | [RELEASE_READINESS.md](RELEASE_READINESS.md) |

## Phase Progress (weights = CLAUDE.md/owner defaults, WEIGHTS_PENDING)

| Phase | Weight | Progress | Weighted | Status | Owner (proposed) | Top Blocker |
| ----- | -----: | -------: | -------: | ------ | ---------------- | ----------- |
| Payer Web Alpha | 25% | 74% | 18.5 | VERIFY | Prakash / Utkarsh | No staging run; Team-RBAC + Account-edit stubs |
| Worker App Alpha | 20% | 67% | 13.4 | BLOCKED | Rishi (Flutter) | B1 handset run (P0); ADR-0026 mobile auth merged; tabs mock |
| Backend/API/Event | 20% | 80% | 16.0 | VERIFY | Divyanshu | posting-plans guard in progress (D3); ADMIN + ADR-0026 backend merged |
| OTP/Auth/Security | 10% | 78% | 7.8 | VERIFY | Divyanshu | PIN+device+rotation merged (scrypt); real-send unproven; 4 throttle fast-follows |
| Agency Demand Alpha | 10% | 68% | 6.8 | VERIFY | Prakash | No staging run; payouts/KYC parked |
| Resume + Interview Kit | 7% | 75% | 5.25 | VERIFY | Divyanshu | D5 DECIDED: PDF required for alpha; enable `RESUME_RENDER_ENABLED=true` + WeasyPrint on staging |
| Infra/Staging/Release | 5% | 45% | 2.25 | PARTIAL | DevOps/Prakash | Staging CD inert/unwired (P0) |
| Docs/Tracker/Process | 3% | 80% | 2.40 | IN_PROGRESS | TPM | — |
| **TOTAL** | **100%** | **72%** | **72.4** | | | |

## Main Task Progress

### Payer Web Alpha (74%)
| Main Task | Progress | Status | Evidence | Next Action |
| --------- | -------: | ------ | -------- | ----------- |
| Login / OTP (email) | 80% | VERIFY | `login/` real provider; 3 tests; OTP real-only | Prove real ZeptoMail send (staging, OTP-7) |
| Dashboard (role-aware) | 82% | VERIFY | `dashboard/page.tsx` live credits/unlocks/postings; tests | Click-through on staging |
| Post Job | 82% | VERIFY | `postings/new` → live `POST /payer/job-postings`; tests | Staging persist check |
| Manage Postings | 65% | PARTIAL | list live; pause/resume/quota = mock store | Wire lifecycle routes |
| Applicant Feed | 82% | VERIFY | live `reach/applicants`; faceless; tests | Staging click-through |
| Unlock / Reveal | 70% | PARTIAL | live both; **rides InternalServiceGuard + body payer_id (LC-1)**; masked-resume mock | Close LC-1; live masked-resume |
| Wallet / Credits | 65% | PARTIAL | balance live; top-up mock money; ledger/history mock | Wire credit ledger reads |
| Capacity | 70% | PARTIAL | live buy (mock money); enforcement INERT | Confirm enforcement plan |
| Team / Org RBAC | 45% | PARTIAL | `team/` stub; `listOrgMembers` STUBBED | Build org-member API |
| Account / Profile | 55% | PARTIAL | read live; edit endpoint missing (PROFILE-4) | Build account-edit route |

### Worker App Alpha (62%) — **P0: not runnable/verified on a real handset (B1)**
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
| Swipe feed + apply/skip | 65% | PARTIAL | feed+apply real; **job-detail = client-side mock synthesis** | Real job-detail endpoint (ADR) |
| Profile tab | 45% | PARTIAL | mock-only repo | Real profile-summary endpoint |
| Notifications | 40% | PARTIAL | mock-only (3 canned) | Real signal source |
| Settings | 25% | PARTIAL | placeholder (logout/delete stub) | Real session/delete |
| Voice note | 10% | PARKED | placeholder; STT deferred (§8) | Do not build (Phase-2) |

### Backend / API / Event Foundation (77%)
| Main Task | Progress | Status | Evidence | Next Action |
| --------- | -------: | ------ | -------- | ----------- |
| Auth/OTP service (breaker+kill-switch) | 82% | VERIFY | `otp.service.ts`; real-only; PII-free logs; tests | Real-send proof |
| Events spine (createEvent + schema) | 85% | VERIFY | `events/`; validated; 1141 api tests green | Staging event flow |
| Job postings API | 82% | VERIFY | `job-postings/`; events; tests | Staging |
| Applications / feed API | 80% | VERIFY | `applications/`; consent-gated; tests | Staging |
| Unlock / reveal API | 70% | PARTIAL | `unlocks/`; **InternalServiceGuard + body payer_id (LC-1)** | Close LC-1 |
| Credits/wallet + ledger idempotency | 80% | VERIFY | migration 0028; ON CONFLICT DO NOTHING; tests | Staging |
| Capacity / posting-plans API | 60% | PARTIAL | D3 DECIDED: InternalServiceGuard guard in progress (Divyanshu) | Guard PR + tests |
| Agency API | 78% | VERIFY | `agency/`; PayerRoleGuard; tests | Staging |
| Admin ops (1/2/3a/3b/3c committed) | 78% | VERIFY | All 4 committed + green; 3c kill-switch (#165) | D4 DECIDED: Prakash owns weekly review; enable 3b once cadence live |
| Health (DB+Redis) | 85% | VERIFY | `health/`; no secret leak; tests | Staging probe |

### Worker Auth (ADR-0026) — ALL 5 PHASES MERGED 2026-06-29
Phase 1 (#162) + Phase 2 (#167) + Phase 3 (#168) + Phase 4 (#170) + Phase 5 (#169) — all merged by Divyanshu Pant. Rotating refresh tokens, trusted-device binding, device-bound PIN (scrypt), mobile↔backend contract reconciliation, and DPDP account deletion. Program rollup **~80%** (code complete + unit-tested; gated off by default pending staging proof). **D7 RESOLVED:** merged Phase 3 uses `crypto.scrypt` per ADR-0026 (`pin-hasher.service.ts`), Argon2id correctly deferred to TD55 — no §3 deviation. **Fast-follows before real-SMS/prod:** 4 deferred MEDIUM PIN throttle/rate-limit findings (PR #168), `PAYER-PIN-1` held pending amendment, account-deletion prod endpoint §7-deferred ([WORKER_AUTH_ADR0026.md](WORKER_AUTH_ADR0026.md)).

### Payer-Web Go-Live + Android API (delivered 2026-06-29)
Verified API-surface extraction produced two docs: the **[payer/agency go-live plan](PAYER_WEB_GO_LIVE_PLAN.md)** (gap list + ordered backend/FE work + per-flow checklist) and the **[Android API reference](../api/payer-agency-api-reference.md)** for Rishi. Headline: payer mobile auth works **today** via Bearer (token in response body); the go-live blockers are posting-plans IDOR (G1/G2), company posting pause/resume + quota (G4/G5), and 3 mock→live wiring swaps (masked-resume, account-edit, credit-ledger).

## Final Task Progress (selected — full set rolls up above)

| Main Task | Final Task | Progress | Status | Blocker | Evidence | Acceptance |
| --------- | ---------- | -------: | ------ | ------- | -------- | ---------- |
| Login OTP | ZeptoMail email-OTP send | 75% | BLOCKED | Real-send gate (OTP-7) | tests green; no real send | OTP received, no PII in logs |
| Post Job | Live `/payer/job-postings` integration | 82% | VERIFY | None | live + tests | Job persists via live API |
| Unlock/Reveal | Per-payer auth on money route | 40% | BLOCKED | LC-1 (TD33/TD50) | rides InternalServiceGuard | Caller payer_id from session, not body |
| Posting plans | Guard the `/plan` + `/boost` routes | 50% | IN_PROGRESS | D3 decided (guard) | controller fix in progress | Auth guard + ownership check |
| Admin PII reveal (3b) | Reason-gated reveal committed + green | 78% | VERIFY | D4: cadence must go live | merged green; D4 owner = Prakash (weekly review) | Weekly audit-stream review + 1-yr retention operational |
| Worker app | Handset onboarding->resume on staging | 0% | BLOCKED | B1 / staging — **sprint -> 2026-07-04** | screenshots in `docs/qa/evidence/b1`; still missing staging events + clean logcat + PDF-open proof | 3 evidence families (screenshots + events + logcat), plus PDF `resume.downloaded` |
| Credits | Real credit-ledger history read | 50% | PARTIAL | endpoint | UI on mock store | History from live ledger |

---

## Module Classification (DONE / VERIFY / PARTIAL / BROKEN / BLOCKED / PARKED / DEAD / LEGAL_GATE / UNKNOWN)

**VERIFY** (built + unit-tested, needs runtime/staging proof): payer-web login/dashboard/post-job/applicants; backend auth/OTP/events/job-postings/applications/credits/health/agency/admin(1-3b); worker-app auth/consent/name/chat/profile/resume/kit; AI pseudonymization+extraction; design system.

**PARTIAL** (some working, some missing): payer-web manage-postings, unlock/reveal, wallet, capacity, team-RBAC, account; backend unlock/reveal (LC-1), posting-plans (unguarded); worker-app swipe(job-detail), profile-tab, notifications, settings.

**BLOCKED:** worker-app alpha (B1 handset/staging); staging CD (unwired).

**PARKED (do not build now):** voice/STT, agency payouts/KYC/bulk-upload, learned Reach ranking, real payments/WhatsApp/STT providers, raw-phone reveal, production legal copy, finalized RLS.

**DEAD:** `DEV_QUICK_LOGIN` / dev/mock OTP — **removed** (real-only OTP, commit `d2f228e`). Do not reintroduce.

**LEGAL_GATE:** DPDP production consent copy + erasure policy; real-money payments; real-send OTP activation; **admin PII-reveal operational conditions (R24/OQ-7: weekly review + 1-yr retention).**

**UNKNOWN (needs runtime check):** dark-theme parity completeness; formal WCAG/a11y conformance; e2e suite behaviour against real PG+Redis (only CI-run today).

---
_Math: overall = Σ(phase% × weight) = 72.4 → reported 72% (conservative; no runtime/staging proof). Re-scored 2026-06-29 after 9 merges; next re-score after the first staging run (B1 sprint → 2026-07-04)._
