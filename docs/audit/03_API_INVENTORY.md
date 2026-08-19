# 03 — API Inventory

Every HTTP route in `apps/api` (NestJS) and `apps/ai-service` (FastAPI), with auth, the
service/tables it touches, external calls, events emitted, queue interaction, test coverage,
and a criticality class. Compiled by reading all 62 `apps/api` controllers in full and all 10
`apps/ai-service` routers in full, cross-checked against frontend/mobile call-site greps for
the CALLER evidence.

**Totals**: apps/api = 217 routes / 62 controllers. apps/ai-service = 15 routes / 10 routers.
**232 routes total.**

> **Counts are a dated snapshot; the route rows are not.** These aggregates were compiled by
> reading every controller in full at the time of the audit, and several other files in
> `docs/audit/` cross-reference them. Routes added since are listed in the tables below (they are
> the useful part of this register) WITHOUT bumping the totals, because a count moved here and
> not in the files that quote it is worse than a count that is openly a snapshot. Added after the
> snapshot: `GET /admin/dashboard/summary` (BP-5).

## Criticality classes

- **A** — Critical production (core worker/payer/admin auth and product flows)
- **B** — Production, not business-critical (has a confirmed frontend caller, lower stakes)
- **C** — Internal/service-to-service only (`InternalServiceGuard`/`SkillsInternalGuard`,
  ops-console or AI-service-to-API traffic)
- **D** — Legacy/compatibility (an ops-era route superseded by a payer-session route, kept
  deliberately — see [07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md))
- **E** — Suspected dead (no verified callers) — **none found in apps/api or apps/ai-service**;
  every route traces to either a confirmed frontend/mobile caller, a confirmed internal caller,
  or an explicit "built ahead of its UI" note from the route's own docstring (classed F below,
  not E, because the code itself documents the gap rather than the audit inferring one)
- **F** — Built and guarded, but no confirmed caller found yet (mostly the admin-web surface —
  see note below)

## Test coverage

apps/api: 46 of 62 controllers have a co-located `*.controller.test.ts`. The 16 without one
(`admin-actions`, `admin-directory`, `admin-entities`, `admin-events`, `admin-finance`,
`admin-kill-switch`, `admin-pii-reveal`, `agency-invites`, `agency-jobs`, `agency-workers`,
`devices`, `resume-disclosure`, `jobs`, `pace`, `referral-bonus`, `skills`) all have adjacent
`*.service.test.ts`/`*.authz.test.ts`/`*.repository.test.ts` instead — business logic is
tested, but the HTTP/guard-wiring layer for those 16 is not directly exercised by a
controller-level test.

apps/ai-service: 13 of 15 routes have direct test coverage. **Gap**: `POST /profiling/turn`
has only a unit test on its internal parser (no `TestClient` HTTP-level test), and
`POST /profiling/extract` has no dedicated test file at all — both are production-critical
(Class A), wired from `apps/api`. Flagged for Batch 2 / QA follow-up.

## Class-F note (routes with no confirmed caller yet)

Every admin-portal route beyond `/admin/login/*`, `/admin/mfa/verify`, `/admin/logout`,
`/admin/me`, `/admin/capabilities`, `/admin/kill-switch/status`, and `/admin/events/metrics`
is fully built, guarded (`AdminAuthGuard` + `AdminRolesGuard` + capability check), and
service/authz-tested, but has no confirmed `apps/admin-web` caller today. This matches the
repo's documented "build-ahead-of-UI" pattern (ADMIN-4..8/OBS-4 are explicitly deferred in the
routes' own docstrings) — it is not evidence of dead code, and Class F is deliberately kept
distinct from Class E for that reason. Two agency routes (`admin-kill-switch`'s
`pause-request`, `agency-invites`' agent-scoped `click`) are similarly built-but-uncalled.

---

## apps/api — by module

### auth

| M | Path | Auth | Class | Notes |
|---|---|---|---|---|
| POST | /auth/otp/request | none (IP-capped) | A | Fast2SMS; events: worker.otp_requested/cap_exceeded/send_failed |
| POST | /auth/otp/verify | none | A | events: worker.otp_verified, worker.created |
| POST | /auth/test-login | TestLoginGuard (404 off) | C | staging/e2e only |
| GET | /auth/me | WorkerAuthGuard | A | |
| POST | /auth/refresh | WAG + ConsentNotRevokedGuard | A | |
| POST | /auth/logout | WAG | A | |
| POST | /auth/token/refresh | none (refresh token = credential) | A | events: worker.refresh_reuse_detected |
| POST | /auth/logout-all | WAG | A | |
| GET | /auth/session | WAG | B | |
| POST | /auth/account/delete/request | WAG | A | |
| POST | /auth/account/delete/confirm | WAG | A | enqueues account-deletion sweep |
| POST | /auth/account/delete/cancel | WAG | A | |
| GET/PATCH/DELETE | /auth/devices, /auth/devices/me/push-token, /auth/devices/:id | WAG | B | no controller test (service-tested) |
| POST | /auth/pin/set | WAG | B | |
| POST | /auth/pin/verify | none (refresh token = credential, ADR-0026) | A | |
| POST | /auth/pin/reset/request, /reset/confirm | none (IP-capped) | B | |

### consent, admin (auth/directory/entities/finance/dashboard/events/kill-switch/pii-reveal/actions)

| M | Path | Auth | Role | Class | Notes |
|---|---|---|---|---|---|
| POST | /consent/accept, /consent/withdraw | WAG | - | A | |
| POST | /admin/login/request, /login/verify, /mfa/verify | none (IP-capped) | - | A | ZeptoMail |
| POST/GET | /admin/refresh, /admin/logout, /admin/me | AdminAuthGuard | - | B | |
| GET | /admin/admins, /admin/capabilities | AAG+ARG | manage_admins / read_entities | F/B | capabilities called by admin-web |
| GET | /admin/workers(/:id), /admin/payers(/:id)(/credits), /admin/job-postings(/:id), /admin/applications | AAG+ARG | read_entities | F | built, no confirmed admin-web caller yet |
| GET | /admin/finance/{summary,ledger,orders} | AAG+ARG | read_entities | F | |
| GET | /admin/dashboard/summary | AAG+ARG | read_entities | F | BP-5; platform AI spend (`platform_ai_cost_totals`) + volume counts; `windowDays` scopes the cap-breach block only |
| GET | /admin/events(/:id/metrics/export/trace) | AAG+ARG | read_events | F/B | metrics called by admin-web |
| GET | /admin/kill-switch/status | AAG+ARG | toggle_kill_switch | B | called by admin-web |
| POST | /admin/kill-switch/pause-request | AAG+ARG | toggle_kill_switch | F | no pairing enable action found |
| POST | /admin/workers/:id/reveal-contact | AAG+ARG | reveal_pii | F | **default-OFF flag `ADMIN_PII_REVEAL_ENABLED`, 404 while off** — R24's most sensitive route, 8 documented controls, see [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md) |
| POST | /admin/payers/:id/{suspend,reinstate,credits}, /admin/job-postings/:id/close, /admin/workers/:id/{flag,unflag}, /admin/admins* | AAG+ARG | per-action capability | F | all built/guarded/tested, no confirmed FE caller |

### chat, profiling, profiles, voice, resume (worker AI path)

| M | Path | Auth | Class | External | Queue |
|---|---|---|---|---|---|
| POST | /chat/session, /chat/message | WAG,ConsentGuard | A | ai-service | - |
| GET | /chat/sessions/:id/messages, /chat/session/latest | WAG,CG | A | - | - |
| POST | /profiling/session, /answer, /correct, /finalize | WAG,CG | A | ai-service | - |
| GET | /profiling/session/:id | WAG,CG | A | - | - |
| POST | /profile/extract | WAG,CG | A | ai-service (async) | profile-extraction |
| POST | /profile/confirm | WAG,CG | A | - | resume-generate (on confirm) |
| GET | /ai-jobs, /ai-jobs/:id | InternalServiceGuard | C | - | - |
| GET | /workers/me/ai-jobs/:id | WAG,CG | A | - | - |
| POST | /voice/upload-url, /upload, /transcribe | WAG,CG (voice_processing purpose) | B | Supabase Storage, ai-service (async STT) | voice-transcription |
| GET | /voice/:voiceNoteId | WAG,CG | B | - | - |
| POST | /resume/generate | WAG,CG | A | ai-service | resume-generate → resume-render |
| GET | /resume/:id | ISG | C | - | - |
| POST | /resume/:id/regenerate | ISG | C | ai-service | resume-generate |
| GET | /resume/:id/download | WAG | A | Storage (signed URL) | - |
| POST | /resume/:id/share | ISG | C | - | - |

### workers, applications, jobs, job-postings, notifications

| M | Path | Auth | Class | Notes |
|---|---|---|---|---|
| GET | /workers | ISG | C | ops/enumeration — see R28 (closed) |
| GET | /workers/me/{profile-summary,resume-fields,photo-url,profile} | WAG,CG | A | |
| GET | /workers/:id/profile | ISG | C/D | superseded for worker-self by `/me/profile` |
| PUT | /workers/:id/name | ISG | D | legacy; worker-self path is `PATCH /workers/me/name` |
| PATCH | /workers/me/name | WAG,CG | A | |
| PATCH | /workers/me/resume-prefs | WAG,CG | A | |
| POST/DELETE | /workers/me/photo(/upload-url) | WAG,CG | A | Storage; triggers resume-render |
| GET | /feed | WAG,CG | A | event: feed.shown per row |
| POST | /applications/:jobId/{apply,skip} | WAG,CG | A | event: application.submitted/skipped |
| GET | /workers/me/applications | WAG,CG | A | |
| GET | /jobs/:jobId/applicants, /workers/:workerId/applications | ISG | C | |
| GET | /jobs/:jobId | WAG,CG | A | deliberately no event |
| POST/GET/PATCH | /job-postings(/:id)(/close/verify/reject/reach/widen) | ISG | B/F | list/get/update/close called by apps/web; verify/reject no confirmed caller |
| GET/PATCH | /workers/me/notification-prefs, /notifications, /notifications/read | WAG,CG | B | |

### payer-portal auth/account/capacity, job-posting-chat, job-postings, pricing

| M | Path | Auth | Class | Notes |
|---|---|---|---|---|
| POST | /payer/signup, /login/request, /login/verify | none (IP-capped) | A | ZeptoMail/SMS |
| POST | /payer/test-login | PayerTestLoginGuard | C | staging/e2e |
| POST | /payer/refresh, /logout | PayerAuthGuard | A | |
| GET/PATCH | /payer/me | PAG | A | |
| GET/POST | /payer/capacity | PAG | A | mock payment |
| GET/POST | /payer/resume-disclosures | PAG | A | Storage (masked PDF) |
| POST/GET | /resume-disclosures | ISG | D | interim ops seam, superseded by payer path |
| POST/GET | /payer/job-posting-chat/{session,message,sessions,sessions/:id/messages,sessions/:id/publish} | PAG | A | ai-service |
| POST/GET/PATCH | /payer/job-postings(/:id)(/close/pause/resume/plan/boost/quota-topup) | PAG | A | mock payment on plan/boost/quota-topup |
| POST | /payers/:payerId/capacity | ISG | D | superseded by /payer/capacity |
| POST | /job-postings/:id/{plan,boost} | ISG | D | `@deprecated` in its own docstring |
| GET/PUT | /pricing/catalog, GET /pricing/quote | ISG | B | called by apps/web; was R31 (closed 2026-08-01) |
| GET | /payer/pricing/catalog | PAG | A | |

### unlocks / disclosures / payments

| M | Path | Auth | Class | Notes |
|---|---|---|---|---|
| POST/GET | /payer/unlocks(/:id/reveal) | PAG | A | events: unlock.*, contact.revealed |
| GET | /payer/credits, /credits/ledger | PAG | A | |
| POST | /payer/credits, /credits/order, /credits/verify | PAG | A | mock path + Razorpay path (order/verify 404 while `PAYMENTS_ENABLE_REAL` off) |
| POST | /payments/razorpay/webhook | RazorpayWebhookGuard (HMAC) | A | inbound from Razorpay |
| POST/GET | /unlocks(/:id/reveal) | ISG | D | ops-only; payer path is canonical |
| GET | /payers/:payerId/credits, POST same | ISG | C | ops top-up/backfill |

### reach, org, agency

| M | Path | Auth | Class | Notes |
|---|---|---|---|---|
| GET | /payer/reach/jobs/:jobId/applicants | PAG | A | |
| GET/POST | /payer/match/skills, /match/reach-preview | PAG | A | |
| GET | /reach/jobs/:jobId/applicants, /reach/workers/:workerId/feed | ISG | B | called by apps/web ops/reach |
| POST/GET/DELETE | /payer/org/{invites/accept,members,members/:id} | PAG,PayerOrgRoleGuard | A | |
| POST/GET/PATCH | /payer/agency/{invites,invites/batch,jobs,jobs/:id,workers,referrals/summary} | PAG, agent role | A/F | invites/:code/click (agent-scoped) has no confirmed FE caller — see 06_DEAD_CODE_AUDIT.md |
| POST/GET | /payer/agency/{kyc,earnings,payouts} | PAG,agent,AgencyPayoutsEnabledGuard | B | 404 while `AGENCY_PAYOUTS_ENABLED` off |
| GET/POST | /ops/agency-kyc/{pending,:payerId/verify,:payerId/reject} | ISG | B | called by apps/web |

### messaging, referrals, interview-kit(s), pace, occupation, skills, events, health, actions

| M | Path | Auth | Class | Notes |
|---|---|---|---|---|
| POST | /invites, /invites/:code/click | WAG / none (IP-capped) | A | |
| POST | /messaging/reengage | ISG | C | |
| GET | /r/:code | none | A | referral link resolver |
| POST | /referrals/attribute | WAG (IP-capped) | A | fire-and-forget event |
| POST/GET | /referrals/bonus/evaluate, /bonus/summary | ISG | C | manual ops re-run; real trigger is the referral-bonus queue |
| GET | /interview-kit/:tradeKey/download, /interview-kits(/:tradeKey) | none (IP-capped) | B | deliberately no PII/no event on list/detail |
| POST/GET | /pace/jobs/:jobId/start, /pace/alerts | ISG | C/B | alerts called by apps/web; was R36 (closed 2026-08-01) |
| POST/GET | /internal/occupation/*, /internal/skills/* | SkillsInternalGuard | C | |
| GET | /events | ISG | B | called by apps/web |
| GET | /health | none | A | |
| POST | /actions, /actions/batch | ISG | C | |
| POST | /workers/me/actions, /actions/batch | WAG,CG | A | |

---

## apps/ai-service — all 15 routes

Global gate: `service_auth` middleware applies TD67 bearer auth (`x-ai-internal-token`,
timing-safe compare) to every route except `/health` — but only when `AI_INTERNAL_TOKEN` is
set. Unset (the default in every committed compose file), the service has no auth of its own;
contained by loopback-only port binding — see [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md) §F3.

| Method/Path | Purpose | External | Class | Test |
|---|---|---|---|---|
| GET /health | liveness + posture | none | A | yes |
| GET /ai/spend | PII-free spend telemetry | none | C | yes (no in-repo caller — ops/manual) |
| POST /pseudonymize | the gateway itself | none | A | yes |
| POST /profile/extract | transcript → draft profile | Gemini/Claude, embeddings | A | yes |
| POST /profile/parse | OIE answer-map typing/citation | Gemini/Claude | A | yes |
| POST /profiling/turn | Phase-A LLM-led question | Gemini/Claude | A | **gap — parser-only unit test, no HTTP test** |
| POST /profiling/extract | Phase-C whole-conversation extraction | Gemini/Claude | A | **gap — no dedicated test file** |
| POST /resume/generate | résumé text + json | Gemini/Claude | A | yes |
| POST /voice/transcribe | STT + optional translate | Sarvam STT, Sarvam Translate | A | yes |
| POST /job-posting-chat/opening | static opener | none | A | yes |
| POST /job-posting-chat/respond | one payer turn, deterministic engine | none today (rephrase seam unwired) | A | yes |
| POST /skills/canonicalize | job-side skill canonicalization | embedding provider | A | yes |
| POST /skills/retag-plan | pure-compute retag plan | none | B | yes |
| POST /embeddings/skill-alias | batch embed | embedding provider | B | yes |
| POST /growth/cluster | pure-compute clustering | none | B | yes |

**PII structural note**: `/pseudonymize`, `/profile/extract`, `/profile/parse`,
`/profiling/turn`, `/profiling/extract`, `/job-posting-chat/respond` accept raw free text by
design (the defined privacy boundary — `pseudonymize()` must run before any LLM leg, verified
in every router). `/resume/generate`'s pseudonymize gate (previously a documented gap) is
confirmed present at `routers/resume.py:93`. `/voice/transcribe` returns raw worker PII in its
own response by design (the worker needs their words back) — must never be relayed further
unmasked. See [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md) for the full privacy-boundary audit.
