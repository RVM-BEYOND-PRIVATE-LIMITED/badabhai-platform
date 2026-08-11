# Payer Feature Audit — endpoint matrix & wiring

**Status:** COMPLETE (audited 2026-08-11, dimension re-run after the usage-limit interruption).
**Method:** evidence-based static analysis; every claim carries a `file:line` citation.
**Findings feed** `GAP_REGISTER.md`. Coverage caveats: `AUDIT_STATUS.md`.

---

# Payer (employer/company) backend endpoint matrix — apps/api /payer/* surface and its payer-web consumers

## Executive summary
The company-facing payer surface is 42 routes across 12 controllers (11 in apps/api/src/payer-portal + apps/api/src/payers/payer-account.controller.ts + apps/api/src/match/match-skills.controller.ts). By status: 21 COMPLETE, 6 IMPLEMENTED-NOT-SECURE, 5 BACKEND-EXISTS-FRONTEND-NOT-CONNECTED, 6 PARTIAL, 2 FLAG-GATED-OFF, 2 IMPLEMENTED-NOT-TESTED-at-HTTP. Zero routes are MISSING and zero payer-web calls hit a non-existent path — the seam cross-lists cleanly in both directions, which is the healthiest single fact in this dimension. The severe defect is monetary: `POST /payer/credits` (apps/api/src/payer-portal/payer-unlocks.controller.ts:129) reaches `UnlockService.purchaseCredits` → `PaymentGateway.purchasePackMock` (apps/api/src/unlocks/payment-gateway.ts:166) with NO `PAYMENTS_ENABLE_REAL` check and NO `NODE_ENV` check, so any authenticated payer can mint unlimited credits for free in production; the same class of hole exists on `:id/plan`, `:id/boost`, `:id/quota-topup` and `POST /payer/capacity`, all of which grant paid entitlements through mock-pay paths that are unconditionally live. Second, the authz regression net covers only 19 of 42 payer routes — apps/api/src/common/guard-contract.test.ts never imports PayerAccountController, PayerJobPostingsController, PayerDisclosureController, PayerOrgMembersController, PayerOrgInvitesController or JobPostingChatController, so 23 routes (55%) can lose a guard with every test still green, and `PayerRoleGuard` is a documented no-op when `@PayerRoles` is absent (apps/api/src/payers/payer-role.guard.ts:43). Third, no HTTP-level test exists for any payer route: all 12 colocated controller tests instantiate the class directly with mocked services, so no test ever executes `PayerAuthGuard`, `ZodValidationPipe`, or Nest routing, and both e2e suites that would (tests/e2e/payer-tenancy.e2e.test.ts:93, tests/e2e/payer-capacity.e2e.test.ts:106) are hard `describe.skip`. Event-First is largely honoured — every state-mutating route emits a validated event except `POST /payer/logout`, which revokes a session with no spine record. Pagination is the weakest engineering dimension: `GET /payer/job-postings` is a hard `limit = 100` with no cursor and no client-settable page (apps/api/src/job-postings/job-postings.repository.ts:202), `GET /payer/unlocks` and `GET /payer/resume-disclosures` cap at 500 with no cursor, and the default-flag reach path reads the ENTIRE worker pool with no LIMIT and emits one `feed.shown` per worker per request (apps/api/src/reach/reach.service.ts:114,125-138). Five backend routes have no payer-web consumer at all — `POST /payer/refresh`, `GET /payer/resume-disclosures`, `POST /payer/job-postings/:id/plan`, `/boost` — all consumed only by apps/payer-app (Flutter); payer-web therefore has no session-refresh path and no way to buy a posting plan or boost. Finally, the previously-verified `getOrgRole()` stub (apps/payer-web/src/lib/auth/org-roles.ts:46-56) makes all three payment Server Actions and all three team actions unreachable 404s for every real user, so the entire money-in loop and the entire team loop are dead on the web portal even where the backend is correct.

> Register generated 2026-08-11 against branch `feat/747a-spoken-digit-redaction` (0 ahead / 1 behind `origin/main`). READ-ONLY audit. Every claim below is anchored to a file:line that was opened and read.

## 0. Scope and method

The payer (employer/company) surface = every route mounted under `/payer/*` that is NOT the agency sub-surface (`/payer/agency/*`, a separate dimension). That is **42 routes across 12 controllers**:

| Controller | File:line | Class guards | Routes |
|---|---|---|---|
| `PayerAuthController` | `apps/api/src/payer-portal/payer-auth.controller.ts:34` | none (per-method) | 5 |
| `PayerAccountController` | `apps/api/src/payers/payer-account.controller.ts:18` | `PayerAuthGuard` | 2 |
| `PayerUnlocksController` | `apps/api/src/payer-portal/payer-unlocks.controller.ts:46` | `PayerAuthGuard` | 8 |
| `PayerJobPostingsController` | `apps/api/src/payer-portal/payer-job-postings.controller.ts:65` | `PayerAuthGuard` | 10 |
| `PayerCapacityController` | `apps/api/src/payer-portal/payer-capacity.controller.ts:22` | `PayerAuthGuard` | 2 |
| `PayerPricingController` | `apps/api/src/payer-portal/payer-pricing.controller.ts:40` | `PayerAuthGuard` | 1 |
| `PayerReachController` | `apps/api/src/payer-portal/payer-reach.controller.ts:35` | `PayerAuthGuard` | 1 |
| `PayerDisclosureController` | `apps/api/src/payer-portal/payer-disclosure.controller.ts:36` | `PayerAuthGuard` | 2 |
| `PayerOrgInvitesController` | `apps/api/src/payer-portal/payer-org-invites.controller.ts:17` | `PayerAuthGuard` | 1 |
| `PayerOrgMembersController` | `apps/api/src/payer-portal/payer-org-members.controller.ts:33` | `PayerAuthGuard, PayerOrgRoleGuard` | 3 |
| `JobPostingChatController` | `apps/api/src/payer-portal/job-posting-chat/job-posting-chat.controller.ts:38` | `PayerAuthGuard` | 5 |
| `MatchSkillsController` | `apps/api/src/match/match-skills.controller.ts:28` | `PayerAuthGuard` | 2 |

Module registration verified at `apps/api/src/payer-portal/payer-portal.module.ts:96-106` (9 controllers); `PayerAccountController` is registered by `payers.module.ts`, `JobPostingChatController` by `job-posting-chat.module.ts`, `MatchSkillsController` by `match.module.ts`.

**Guard semantics, established once:** `PayerAuthGuard` (`apps/api/src/payers/payer-auth.guard.ts:82-136`) validates the Bearer payer JWT, then does a per-request `findAuthFacts` row read and **403s anything but `status === 'active'`** (`:116-118`) — this is the ADR-0037 suspension gate. It attaches `req.payer = {id, sid, role}` from the DB row, not the JWT claim (`:120-125`), and rolls a fresh token into `x-session-token` past the half-life (`:127-133`). `PayerOrgRoleGuard` (`apps/api/src/payers/payer-org-role.guard.ts:64+`) resolves the caller's active org membership from the DB and enforces `@OrgRoles`.

---

## 1. Route matrix

Legend for the "Event" column: the event name emitted through `EventsService.emit` (validated against `@badabhai/event-schema`), or `—` for a read.

### 1.1 PayerAuthController — `apps/api/src/payer-portal/payer-auth.controller.ts`

| Route | Ctrl line | Service method | Tables | Guards (effective) | DTO + validation | Response | Page/Filter | Errors | Event | payer-web consumer | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST /payer/signup` | :43 | `PayerAuthService.signup` (`payer-auth.service.ts:69`) | `payers`, `payer_orgs`, `payer_members`, `credit_ledger`, `payer_credits`, `events` | none (public) — IP-capped via `IpRateLimit.assertWithinHourlyIpCap("payer_auth", …)` :95-101 | `PayerSignupSchema` via `ZodValidationPipe` :46 | `{status:"code_sent", resend_in_seconds}` | n/a | 429 IP cap; 429 OTP cooldown/global-cap; 503 Redis; delivery 502 swallowed to neutral (:282-287) | `payer.created` (:78, idempotency `payer.created:<id>`), `payer.otp_send_cap_exceeded` (:333) | `http-provider.ts:74` → `login/actions.ts` | `payer-auth.controller.test.ts:33-39` (handler, mocked svc) | COMPLETE |
| `POST /payer/login/request` | :55 | `requestLogin` (:116) | `payers`, `events`, Redis OTP | none (public) + IP cap | `PayerLoginRequestSchema` :58 | same neutral body | n/a | same | `payer.login_requested` (:291), `payer.otp_suppressed` (:258, suspended), `payer.otp_send_cap_exceeded` | `http-provider.ts:52` | same test | COMPLETE |
| `POST /payer/login/verify` | :67 | `verifyLogin` (:135) | `payers`, `payer_orgs`, `payer_members`, `events`, Redis session | none (public) + IP cap | `PayerLoginVerifySchema` :70 | `{access_token, token_type, expires_in_seconds, payer_id, role, is_new_payer}` | n/a | 401 "Incorrect or expired code" (unknown acct + bad code, one message); **403 "Account is suspended"** (:161, rationale :151-159) | `payer.activated` (:170), `payer.session_started` (:184) | `http-provider.ts:99` | same test | COMPLETE |
| `POST /payer/refresh` | :79 | `refresh` (:203) → `PayerSessionService.mint` | Redis session | `[PayerAuthGuard]` | none | `{access_token, token_type, expires_in_seconds}` | n/a | 401 invalid session; 403 non-active | **none** (session mint is not evented) | **NONE in payer-web** — only `apps/payer-app/lib/core/auth/payer_auth_api.dart:149` | `payer-auth.controller.test.ts:49-54` | BACKEND-EXISTS-FRONTEND-NOT-CONNECTED |
| `POST /payer/logout` | :88 | `logout` (:213) | Redis session | `[PayerAuthGuard]` | none | 204 | n/a | 401/403 | **none** — Event-First gap, see §5 | `http-provider.ts:144` | same test | PARTIAL |

### 1.2 PayerAccountController — `apps/api/src/payers/payer-account.controller.ts`

| Route | Ctrl line | Service | Tables | Guards | DTO | Response | Errors | Event | Consumer | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `GET /payer/me` | :28 | `PayerAccountService.getOwnAccount` (`payer-account.service.ts:32`) | `payers` (decrypt) | `[PayerAuthGuard]` (class :19) | none; `Cache-Control: no-store` :29 | `PayerMeDto {id, role, status, orgName, email, phoneLast4}` — phone masked to last 4 (`service:96-99`) | 404 neutral if row gone; **500 fail-closed on decrypt failure** (:92) | — | `payer-api.ts:118`, `:139`; `http-provider.ts:131`; `account/page.tsx` | `payer-account.controller.test.ts` (25 its) | COMPLETE |
| `PATCH /payer/me` | :42 | `updateOwnAccount` (:50) | `payers` (re-encrypt org/phone, refresh phoneHash), `events` | `[PayerAuthGuard]` | `PayerUpdateSchema` `.strict()` — rejects `payer_id`/role/status/email as unknown keys; empty body → 400 | updated `PayerMeDto` | 400 unknown key / empty; 404 neutral | `payer.account_updated` with **field KEYS only, never values** (:70-77) | `account/actions.ts:61` → `updateAccountAction` | same | COMPLETE |

### 1.3 PayerUnlocksController — `apps/api/src/payer-portal/payer-unlocks.controller.ts`

| Route | Ctrl line | Service | Tables | Guards | DTO | Response | Page | Errors | Event | Consumer | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST /payer/unlocks` | :61 | `UnlockService.requestUnlock` (`unlocks.service.ts:128`) | `unlocks`, `payer_credits`, `credit_ledger`, `consents`, `worker_profiles`, `events` | `[PayerAuthGuard]` + `PayerDisclosureRateLimit.assertWithinHourlyCap` :68 | `PayerRequestUnlockSchema` (`payer-unlocks.dto.ts:11`) — `worker_id` uuid, `job_id` uuid nullable, **no payer_id** | one distinguishable success or byte-identical neutral body; HTTP 200 always | n/a | 429 XB-G cap; all denies → neutral 200 | `unlock.requested`(:907)/`unlock.granted`(:949)/`unlock.denied`(:978)/`unlock.cap_exceeded`(:1003)/`credits.exhausted`(:1097) | `payer-api.ts:274` `requestUnlock` → `postings/[id]/applicants/actions.ts:33` | `payer-unlocks.controller.test.ts` (14 its) | COMPLETE |
| `POST /payer/unlocks/:unlockId/reveal` | :82 | `reveal` (:312) | `unlocks`, `unlock_routings`, `events` | `[PayerAuthGuard]` + XB-G cap :89 | `ParseUUIDPipe` on param | routed relay handle only, never a phone | n/a | neutral body for not-owned/unknown/expired; 200 always | `unlock.revealed` (:1028) | `payer-api.ts:299` → `revealContactAction` | same | COMPLETE |
| `GET /payer/unlocks` | :94 | `listByPayer` (:477) → `unlocks.repository.ts:601` | `unlocks` | `[PayerAuthGuard]` | none | `{unlocks: UnlockProjection[]}` PII-free | **`.limit(OPS_LIST_CAP)` = 500, no cursor, no filter** (`unlocks.repository.ts:607`; `common/pagination.ts:16`) | — | — | `payer-api.ts:151` `getUnlocks` → `getDashboard` :174 | same | PARTIAL (no pagination) |
| `GET /payer/credits` | :100 | `getCredits` (:485) | `payer_credits` | `[PayerAuthGuard]` | none | `{payer_id, balance}` | n/a | — | — | `payer-api.ts:145` | same | COMPLETE |
| `GET /payer/credits/ledger` | :111 | `getCreditLedger` (:505) → repo `:344` | `credit_ledger` | `[PayerAuthGuard]` | `PayerLedgerQuerySchema` — `limit` 1..50 default 20, **no cursor/offset** (`payer-unlocks.dto.ts:34`) | `{payer_id, ledger[]}` | limit only; newest-first | **requires migration 0043 (`price_inr`) — unmigrated DB fails the read outright** (repo `:341-343`) | — | `payer-api.ts:416` hardcodes `?limit=50`; KNOWN CAP self-documented at `payer-api.ts:419-421` | same | PARTIAL |
| `POST /payer/credits` | :129 | `purchaseCredits` (:515) → **`PaymentGateway.purchasePackMock`** (`payment-gateway.ts:166`) | `payer_credits`, `credit_ledger`, `events` | `[PayerAuthGuard]` — **no flag gate, no env gate** | `PayerBuyPackSchema` (pack code only) | `{payer_id, balance, credits, pack_code}` 201 | n/a | 404 unknown pack (real 404, not the no-oracle path) | `payment.authorized` + `payment.captured` with `real_call:false` (:527,:532) | `payer-api.ts:320` `topUp` → `credits/actions.ts:26 topUpAction` (gated by the broken `requireOwner()`) | same | **IMPLEMENTED-NOT-SECURE** |
| `POST /payer/credits/order` | :157 | `createCreditOrder` (:565) | `payment_orders`, `events` | `[PayerAuthGuard]` + `if (!realPaymentsLive) throw NotFoundException()` :164 | `CreateCreditOrderSchema` (pack code only — no amount anywhere) | `{order_id, key_id, amount, amount_inr, currency, pack_code, credits}` 201 | n/a | neutral 404 when flag off; 404 unknown pack | `payment.authorized` keyed `payment.authorized:order:<rowId>` (:581) | `payer-api.ts:359` → `credits/actions.ts:87 createOrderAction` | same | FLAG-GATED-OFF |
| `POST /payer/credits/verify` | :191 | `verifyCheckoutPayment` (:602) | `payment_orders`, `payer_credits`, `credit_ledger`, `events` | `[PayerAuthGuard]` + flag gate :198 | `VerifyCreditPaymentSchema` (3 Razorpay ids) | `{payer_id, balance, credits, pack_code}` 200 | n/a | one neutral 404 for forged-signature / unknown order / foreign order (:208-210) | `payment.captured` keyed `payment.captured:order:<id>` **only on the granting call** (`settleAndEmit:721-738`); suspended-payer alert (:769) | `payer-api.ts:387` → `verifyPaymentAction` | same | FLAG-GATED-OFF |

### 1.4 PayerJobPostingsController — `apps/api/src/payer-portal/payer-job-postings.controller.ts`

All 10 routes: `[PayerAuthGuard]` (class :66). **None are in the authz contract. No rate limit of any kind on this controller.**

| Route | Ctrl line | Service | Tables | DTO | Response | Page/Filter | Errors | Event | Consumer | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|
| `POST /payer/job-postings` | :87 | `JobPostingsService.createForPayer` (`job-postings.service.ts:234`) → `insertAndEmit` :462 | `job_postings`, `events`, skill canonicalization | `PayerCreateJobPostingSchema`; `description` runs `looksLikePii` (`job-postings.dto.ts:25-29`) | `JobPostingApi` 201, status=draft | n/a | 400 | `job_posting.created` | `payer-api.ts:1006` `createPosting` → `postings/new/actions.ts` | COMPLETE |
| `GET /payer/job-postings` | :105 | `listForPayer` (:257) → repo `listByPayer` (`job-postings.repository.ts:199-214`) | `job_postings` + N×(`posting_plans`,`posting_boosts`,`resume_disclosures`) via `enrich` :75-84 | `ListJobPostingsQuerySchema` — **`status` only** (`job-postings.dto.ts:183-185`) | `PayerJobPostingView[]` | **hard `limit = 100`, no cursor, no client page size** (`repo:202`) | — | — | `payer-api.ts:962` `getPostings` → `/postings`, `/dashboard` | PARTIAL (no pagination; N+1) |
| `GET /payer/job-postings/:id` | :115 | `getOneForPayer` (:262) | `job_postings` (+stats) | `ParseUUIDPipe` | `PayerJobPostingView` | n/a | neutral 404 unknown OR foreign | — | `payer-api.ts:1024`,`:1041` | COMPLETE |
| `PATCH /payer/job-postings/:id` | :125 | `updateForPayer` (:268) | `job_postings`, `job_reach`, `events` | `UpdateJobPostingSchema` | `JobPostingApi` | n/a | 404 neutral | `job_posting.updated`; on publish/skill-change `job_posting.reach_materialized`, `job_posting.reach_alert` (`materializeIfNeeded` :374-416) | `payer-api.ts:1079` `updatePosting`, `:1143` `publishPostingWithMatchSkills` | COMPLETE |
| `POST /payer/job-postings/:id/close` | :137 | `closeForPayer` (:294) | `job_postings`, `events` | uuid param | `JobPostingApi` 200 | n/a | 404 neutral; 409 already closed | `job_posting.closed` | `payer-api.ts:1166` → `closePostingAction` | COMPLETE |
| `POST /payer/job-postings/:id/pause` | :148 | `pauseForPayer` (:311) | `job_postings`, `events` | uuid param | `JobPostingApi` | n/a | 404; 409 non-open | `job_posting.paused` (:322) | `payer-api.ts:1226` → `pausePostingAction` | COMPLETE |
| `POST /payer/job-postings/:id/resume` | :159 | `resumeForPayer` (:331) | `job_postings`, `job_reach`, `events` | uuid param | `JobPostingApi` | n/a | 404; 409 non-paused | `job_posting.resumed` (:342) + re-materializes reach (:355) | `payer-api.ts:1245` → `resumePostingAction` | COMPLETE |
| `POST /payer/job-postings/:id/plan` | :177 | ownership-first `getOneForPayer` :185 then `PostingPlansService.buyPlanForPayer` (`posting-plans.service.ts:259`) → `buyPlan` :177 | `posting_plans`, `payer_capacity`, `events`; advisory lock `lockPayer` :197 | `PayerBuyPlanSchema` | `{plan, quote, paused, wouldPause}` 201 | n/a | 404 neutral; 400 wrong product kind | `payment.authorized`+`payment.captured`, `job_posting.purchased`, conditionally `posting_plan.paused`, `coupon.redeemed` | **NONE in payer-web** (`plans/page.tsx:137`); `apps/payer-app` only | **IMPLEMENTED-NOT-SECURE** + BACKEND-EXISTS-FRONTEND-NOT-CONNECTED |
| `POST /payer/job-postings/:id/boost` | :194 | `buyBoostForPayer` (:272) → `buyBoost` :281 | `posting_boosts`, `job_postings.boosted_until`, `events` | `PayerBuyBoostSchema` | `{boost, quote}` 201 | n/a | 404; **409 overlapping boost** (:288); ADR-0036 §7 supply-floor refusal BEFORE any payment event (:304) | `payment.*`, `job_posting.boosted` (:339), `job_posting.boost_refused` (:572) | **NONE in payer-web**; `apps/payer-app` only | same as above |
| `POST /payer/job-postings/:id/quota-topup` | :215 | `topUpQuotaForPayer` (:365) | `posting_plans.quota_topup_count`, `events` | `PayerTopUpQuotaSchema` | `{plan, quote}` 201 | n/a | 404; **409 no active plan** (:382, :392) | `payment.*`, `posting_plan.quota_topped` (:410) | `payer-api.ts:1291` → `postings/actions.ts:74 topUpQuotaAction` | **IMPLEMENTED-NOT-SECURE** |

### 1.5 PayerCapacityController / PayerPricingController / PayerReachController

| Route | Ctrl line | Service | Tables | Guards | DTO | Response | Errors | Event | Consumer | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|
| `GET /payer/capacity` | `payer-capacity.controller.ts:33` | `PostingPlansService.getCapacity` (:502) | `payer_capacity`, `posting_plans` (count) | `[PayerAuthGuard]` | none | `CapacityView` incl. `active_plan_count` | — | — | `payer-api.ts:458` → `/capacity`, `/plans` | COMPLETE |
| `POST /payer/capacity` | `:43` | `buyCapacity` (:432) | `payer_capacity`, `posting_plans` (auto-resume under advisory lock), `events` | `[PayerAuthGuard]` | `BuyCapacitySchema` | `BuyCapacityResult` 201 | 400 wrong product kind | `payment.*`, `capacity.purchased` (:713), `posting_plan.resumed` per resumed plan (:684) | `payer-api.ts:513` → `capacity/actions.ts:29` | **IMPLEMENTED-NOT-SECURE** |
| `GET /payer/pricing/catalog` | `payer-pricing.controller.ts:46` | `PricingService.getActiveCatalog` | `pricing_catalog` | `[PayerAuthGuard]` | none | `{revision, source, products}` — deliberately excludes `offers`/`coupons`/`floorPriceInr` (:16-20) | fail-closed to typed default (`source:"default"`) | — | `live-catalog.ts:53` | COMPLETE |
| `GET /payer/reach/jobs/:jobId/applicants` | `payer-reach.controller.ts:63` | flag-branched: `MatchCandidatesService.listForPosting` (:81) when `isMatchV1Enabled`, else `ReachService.applicantsForOwnedJob` (:84) | V1: `applications`,`match_*`; legacy: `worker_profiles` (**full pool**), `events` | `[PayerAuthGuard]` + `PayerDisclosureRateLimit` scope `payer_reach`, cap `PAYER_REACH_MAX_PER_HOUR` (:69-72) | `JobIdParamSchema` | `{jobId, applicants[]}` faceless | 429 cap; neutral 404 unknown/foreign job (:80 V1, `reach.service.ts:109` legacy) | legacy: **one `feed.shown` per ranked worker** (`reach.service.ts:125-138`); **V1 emits NOTHING** (deliberate, ctrl :55-61) | `payer-api.ts:243` `getApplicantFeed` → `postings/[id]/applicants/page.tsx` | PARTIAL |

### 1.6 PayerDisclosureController / Org routes / Chat / Match

| Route | Ctrl line | Service | Tables | Guards | DTO | Response | Page | Errors | Event | Consumer | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST /payer/resume-disclosures` | `payer-disclosure.controller.ts:52` | `ResumeDisclosureService.requestDisclosure` (:78) | `resume_disclosures`, `consents`, `workers`, `events` | `[PayerAuthGuard]` + XB-G cap :59 | `PayerRequestDisclosureSchema` (`payer-disclosure.dto.ts:11`) | one success shape or byte-identical neutral; 200 always | n/a | 429 cap; every deny → neutral 200 | `resume.disclosed` (`resume-disclosure.service.ts:271`); denies via `recordDeny` :307 | `payer-api.ts:1201` `revealMaskedResume` → `applicants/actions.ts:77` | COMPLETE |
| `GET /payer/resume-disclosures` | `:67` | `listByPayer` (:185) → repo `:278` | `resume_disclosures` | `[PayerAuthGuard]` | none | projection list | **`.limit(500)` no cursor** (`resume-disclosure.repository.ts:284`) | — | — | **NONE in payer-web**; `apps/payer-app/lib/core/data/http_payer_api_client.dart:551` | BACKEND-EXISTS-FRONTEND-NOT-CONNECTED |
| `POST /payer/org/invites/accept` | `payer-org-invites.controller.ts:23` | `PayerOrgMembersService.accept` (:149) | `payer_members`, `payers`, `events` | `[PayerAuthGuard]` **only** (deliberate — caller is not yet an org principal, :10-15) | `AcceptInviteSchema` (raw token only) | masked `OrgMemberView` | n/a | 404 neutral bad/expired token; **403 email mismatch** (:164); 409 already used | `payer_member.accepted` (:176) | `org-members.ts:123` → `team/actions.ts:47` | COMPLETE |
| `GET /payer/org/members` | `payer-org-members.controller.ts:39` | `list` (:66) → `payer-orgs.repository.ts:108` | `payer_members` | `[PayerAuthGuard, PayerOrgRoleGuard]` (no `@OrgRoles` ⇒ any member) | none | masked emails | **no LIMIT** — bounded only by `MEMBER_INVITE_MAX_PER_ORG` default 25 (`packages/config/src/server.ts:560`) | 403 no active membership | — | `org-members.ts:73` → `team/page.tsx` | COMPLETE |
| `POST /payer/org/members` | `:45` | `invite` (:80) | `payer_members`, `events`, mailer seam | `[PayerAuthGuard, PayerOrgRoleGuard]` + `@OrgRoles("owner")` :46 | `InviteMemberSchema` | masked `OrgMemberView` 201 | n/a | 409 already active; 409 seat cap (:96); **503 on mailer failure** (:135) | `payer_member.invited` (:116) | `org-members.ts:84` → `team/actions.ts:26` | FLAG-GATED-OFF (delivery) |
| `DELETE /payer/org/members/:id` | `:58` | `remove` (:205) | `payer_members`, `events` | `[PayerAuthGuard, PayerOrgRoleGuard]` + `@OrgRoles("owner")` :59 | `ParseUUIDPipe` | masked view 200 | n/a | 404 neutral foreign/unknown; 409 cannot remove owner | `payer_member.removed` (:224) | `org-members.ts:104` → `team/actions.ts:37` | COMPLETE |
| `POST /payer/job-posting-chat/session` | `job-posting-chat.controller.ts:44` | `startSession` (:111) | chat session/message tables, `events` | `[PayerAuthGuard]` | `StartJobPostingChatSchema` (body ignored, `_dto`) | first turn 201 | n/a | — | `job_posting_chat.session_started` (:114) | `payer-api.ts:1352` → `postings/ai/new/actions.ts:52` | COMPLETE |
| `POST /payer/job-posting-chat/message` | `:56` | `postMessage` (:164) | chat tables, `events`, **ai-service call** | `[PayerAuthGuard]` — **no rate limit, no per-payer spend cap** | `PostJobPostingChatMessageSchema` | reply + draft 201 | n/a | 404 neutral foreign session; **503 when ai-service down, message already persisted** (:212-214) | `job_posting_chat.message_sent` ×2 (:580), `job_posting_chat.draft_ready` (:257) | `payer-api.ts:1370` → `sendJobPostingChatMessageAction` | PARTIAL |
| `GET /payer/job-posting-chat/sessions` | `:72` | `listSessions` (:304) | chat sessions | `[PayerAuthGuard]` | none | summaries | `JOB_POSTING_CHAT_SESSION_LIST_MAX = 50` (`job-posting-chat.repository.ts:24`) | — | — | `payer-api.ts:1389` | COMPLETE |
| `GET .../sessions/:id/messages` | `:85` | `listMessages` (:334) | chat messages | `[PayerAuthGuard]` | `JobPostingChatSessionParamSchema` | transcript + status + draft | `JOB_POSTING_CHAT_HISTORY_MAX = 200` (`repo:21`) | 404 neutral (never 403 — :80-83) | — | `payer-api.ts:1408` | COMPLETE |
| `POST .../sessions/:id/publish` | `:98` | `publish` (:385) → reuses `JobPostingsService.createForPayer` | `job_postings`, chat tables, `events` | `[PayerAuthGuard]` | `PublishJobPostingChatSchema` | posting 201 | n/a | 404 neutral | `job_posting.created` (via the shared create path) | `payer-api.ts:1430` → `publishJobPostingChatAction` | COMPLETE |
| `GET /payer/match/skills` | `match-skills.controller.ts:36` | `MatchSkillsService.listSkills` (:97) | none (checked-in constant) | `[PayerAuthGuard]` | none | `{skills}` | n/a | — | — (deliberate, ctrl :20-26) | `payer-api.ts:1101` | COMPLETE |
| `POST /payer/match/reach-preview` | `:43` | `reachPreview` (:118) | worker supply counts | `[PayerAuthGuard]` | `ReachPreviewSchema` | per-skill reach + total + E13 zero-reach warning; 200 | n/a | — | — (deliberate; evented at publish) | `payer-api.ts:1117` `previewReach` → `postings/new` | COMPLETE |

---

## 2. (a) Cross-listing the seam — does payer-web call a path with no backend route?

**No. Zero orphans in the payer-web → backend direction.** Method: enumerated every `/payer/*` string literal in `apps/payer-web/src` (58 `payerFetch` call sites across `payer-api.ts`, `org-members.ts`, `live-catalog.ts`, `auth/http-provider.ts`, `account/actions.ts`) and matched each against the controller decorators above.

| payer-web path | call site | Backend route | Match |
|---|---|---|---|
| `POST /payer/signup` | `http-provider.ts:74` | `payer-auth.controller.ts:43` | ✔ |
| `POST /payer/login/request` | `http-provider.ts:52` | `:55` | ✔ |
| `POST /payer/login/verify` | `http-provider.ts:99` | `:67` | ✔ |
| `POST /payer/logout` | `http-provider.ts:144` | `:88` | ✔ |
| `GET /payer/me` | `http-provider.ts:131`, `payer-api.ts:118`, `:139` | `payer-account.controller.ts:28` | ✔ |
| `PATCH /payer/me` | `account/actions.ts:61` | `:42` | ✔ |
| `GET /payer/credits` | `payer-api.ts:145` | `payer-unlocks.controller.ts:100` | ✔ |
| `POST /payer/credits` | `payer-api.ts:320` | `:129` | ✔ |
| `GET /payer/credits/ledger?limit=50` | `payer-api.ts:416` | `:111` (`limit` max 50 — hardcoded 50 sits exactly at the ceiling) | ✔ |
| `POST /payer/credits/order` | `payer-api.ts:359` | `:157` | ✔ |
| `POST /payer/credits/verify` | `payer-api.ts:387` | `:191` | ✔ |
| `GET /payer/unlocks` | `payer-api.ts:151` | `:94` | ✔ |
| `POST /payer/unlocks` | `payer-api.ts:274` | `:61` | ✔ |
| `POST /payer/unlocks/:id/reveal` | `payer-api.ts:299` | `:82` | ✔ |
| `GET`/`POST /payer/capacity` | `payer-api.ts:458`,`:513` | `payer-capacity.controller.ts:33`,`:43` | ✔ |
| `GET /payer/pricing/catalog` | `live-catalog.ts:53` | `payer-pricing.controller.ts:46` | ✔ |
| `GET /payer/reach/jobs/:jobId/applicants` | `payer-api.ts:243` | `payer-reach.controller.ts:63` | ✔ |
| `GET`/`POST /payer/job-postings` | `payer-api.ts:962`,`:1006` | `:105`,`:87` | ✔ |
| `GET`/`PATCH /payer/job-postings/:id` | `payer-api.ts:1024`,`:1041`,`:1079`,`:1143` | `:115`,`:125` | ✔ |
| `POST /payer/job-postings/:id/{close,pause,resume,quota-topup}` | `payer-api.ts:1166`,`:1226`,`:1245`,`:1291` | `:137`,`:148`,`:159`,`:215` | ✔ |
| `POST /payer/resume-disclosures` | `payer-api.ts:1201` | `payer-disclosure.controller.ts:52` | ✔ |
| `GET`/`POST /payer/org/members`, `DELETE /payer/org/members/:id` | `org-members.ts:73`,`:84`,`:104` | `payer-org-members.controller.ts:39`,`:45`,`:58` | ✔ |
| `POST /payer/org/invites/accept` | `org-members.ts:123` | `payer-org-invites.controller.ts:23` | ✔ |
| `GET /payer/match/skills`, `POST /payer/match/reach-preview` | `payer-api.ts:1101`,`:1117` | `match-skills.controller.ts:36`,`:43` | ✔ |
| chat ×5 | `payer-api.ts:1352`,`:1370`,`:1389`,`:1408`,`:1430` | `job-posting-chat.controller.ts:44`,`:56`,`:72`,`:85`,`:98` | ✔ |

`apps/payer-web/src/lib/payer-http.ts:44-72` is the only transport; it is `server-only`, reads the httpOnly `bb_payer_token` cookie, and zod-parses every response. There is no second HTTP path in the app.

## 3. (b) Backend payer routes with NO payer-web consumer

| Route | payer-web | Actual consumer | Note |
|---|---|---|---|
| `POST /payer/refresh` | none | **apps/payer-app (Flutter)** — `lib/core/auth/payer_auth_api.dart:149`, orchestrated by `payer_http.dart:64,171,214` | payer-web has no refresh. `PayerAuthGuard:127-133` does return a rolled `x-session-token`, but `payerFetch` never reads response headers, so payer-web discards every rolled token. |
| `GET /payer/resume-disclosures` | none | **apps/payer-app** — `lib/core/data/http_payer_api_client.dart:551` | payer-web only POSTs disclosures; no "my disclosures" page exists. |
| `POST /payer/job-postings/:id/plan` | none | **apps/payer-app** — `/payer/job-postings/$id/plan` | `plans/page.tsx` renders the catalog and links to `/credits`; there is no buy-plan action file. |
| `POST /payer/job-postings/:id/boost` | none | **apps/payer-app** — `/payer/job-postings/$id/boost` | same. |

No payer route is consumed by `apps/web` (ops) or `apps/admin-web` — those consume `/pricing/*`, `/unlocks*`, `/payers/:payerId/credits`, `/ops/agency-kyc`, `/admin/*`. **No payer route has zero consumers across all four clients.**

## 4. (c) Unbounded / unpaginated lists

Read against the repository query, not the DTO:

| Route | Repository query | Bound | Verdict |
|---|---|---|---|
| `GET /payer/job-postings` | `job-postings.repository.ts:199-214` | `limit = 100` default param; controller never passes one and `ListJobPostingsQuerySchema` has **only `status`** (`job-postings.dto.ts:183-185`) | **Hard-truncates at 100 with no cursor.** >100 postings are unreachable by any client. |
| `GET /payer/unlocks` | `unlocks.repository.ts:601-608` | `OPS_LIST_CAP = 500` (`common/pagination.ts:16`) | Bounded, no cursor — the 501st unlock is unreachable forever. |
| `GET /payer/resume-disclosures` | `resume-disclosure.repository.ts:278-284` | hardcoded `.limit(500)` | Same. |
| `GET /payer/credits/ledger` | `unlocks.repository.ts:344-361` | client `limit` 1..50 | No cursor. The frontend self-documents the loss at `payer-api.ts:419-421`. Grows on every unlock debit — the fastest-growing payer list. |
| `GET /payer/reach/jobs/:jobId/applicants` (legacy — **the default**) | `reach.repository.ts:81` `listSignalRows()` — **no `.limit()` at all** | none | **Reads the entire eligible `worker_profiles` pool into memory per request**, ranks in Node (`reach.service.ts:114-121`), emits **one `feed.shown` per worker** (`:125-138`). At 100k workers that is a 100k-row read + 100k spine rows per page view. |
| `GET /payer/reach/...` (V1) | `match-candidates.service.ts:72` | `OPS_LIST_CAP = 500` | Bounded, no cursor. |
| `GET /payer/org/members` | `payer-orgs.repository.ts:108-114` — **no `.limit()`** | seat cap `MEMBER_INVITE_MAX_PER_ORG` default 25 (`packages/config/src/server.ts:560`) | Structurally bounded. Acceptable. |
| `GET /payer/job-posting-chat/sessions` | `job-posting-chat.repository.ts:77-90` | `JOB_POSTING_CHAT_SESSION_LIST_MAX = 50` | Bounded, no cursor. Low risk. |
| `GET .../sessions/:id/messages` | `repo:105-112` | `JOB_POSTING_CHAT_HISTORY_MAX = 200` | Bounded. |

**Separate efficiency defect on the same route:** `GET /payer/job-postings` calls `enrich()` per row (`payer-job-postings.controller.ts:79-83`), and `enrich` issues two independent service calls, one of which itself makes two parallel repo reads (`posting-plans.service.ts:161-164`). At the 100-row cap that is **up to 301 queries for one list render**, and this route backs both `/postings` and `/dashboard` (`payer-api.ts:174`).

## 5. (d) Mutating routes that emit NO event (Event-First)

| Route | State change | Event | Assessment |
|---|---|---|---|
| `POST /payer/logout` (`payer-auth.controller.ts:88`) | `PayerSessionService.revoke(sid)` deletes the Redis session | **none** | **Real gap.** `payer.session_started` is emitted on login (`payer-auth.service.ts:184`) but nothing closes the pair. Session termination has no audit record. |
| `POST /payer/refresh` (`:79`) | mints a new JWT, slides the session TTL | **none** | Defensible (a token roll is not a business action) but it means an unbounded-lifetime session (guard re-slides to a fresh 30 days per request with no ceiling — `payer-auth.guard.ts:64-69`) is invisible on the spine. |
| `POST /payer/credits/verify`, `already_settled` branch (`unlocks.service.ts:639-650`) | none (webhook already granted) | none | **Correct.** `settleAndEmit:721-738` emits `payment.captured` iff this call granted, keyed `payment.captured:order:<id>`. Exactly one capture per order. |
| `POST /payer/match/reach-preview` (`match-skills.controller.ts:43`) | none — POST only because the skill list is a body | none | **Correct and explicitly justified** at `match-skills.controller.ts:20-26`. |
| `GET /payer/reach/.../applicants`, V1 path (`payer-reach.controller.ts:81`) | none | **none**, vs one `feed.shown` per row on the legacy path | Deliberate, reasoned at `:53-61`. But the two flag postures have **incompatible spine signatures**, so analytics keyed on `feed.shown` silently zero on the flip. |

Every other mutating payer route emits a validated event. The money routes are notably thorough: `payment.authorized` + `payment.captured` on every purchase path with an honest `real_call` flag, and order-row-keyed idempotency on the real path.

## 6. (e) Routes with no test that exercises the handler

Every one of the 42 routes has at least one colocated test that **calls the handler method directly** — verified by reading test titles across all 12 files (`payer-account` 25 its, `payer-job-postings` 16, `payer-unlocks` 14, `job-posting-chat` 9, `match-skills` 6, `payer-pricing` 5, `payer-disclosure` 5, `payer-reach` 4, `payer-auth` 3, `payer-capacity` 3, `payer-org-members` 3, `payer-org-invites` 1).

**But none exercise the HTTP layer.** Every test constructs the controller directly — `payer-auth.controller.test.ts:23`, `payer-reach.controller.test.ts:20-26`, `payer-unlocks.controller.test.ts:16-45`. Consequences:

- `ZodValidationPipe` never runs. DTOs are passed as `{…} as never` (e.g. `payer-auth.controller.test.ts:34`), so **no test proves a malformed or hostile body is rejected on any payer route**.
- `PayerAuthGuard` never runs. `guard-contract.test.ts` asserts guard *metadata*, not *behaviour*, and covers only 19 of 42 routes (§7).
- `ParseUUIDPipe` never runs; status codes and the `Cache-Control: no-store` header (`payer-account.controller.ts:29,43`) are never asserted end-to-end.

The two suites that would close this are **both hard-skipped**: `tests/e2e/payer-tenancy.e2e.test.ts:93` and `tests/e2e/payer-capacity.e2e.test.ts:106`. There is no Playwright, Cypress, or supertest anywhere in the repo. **Net: the entire payer HTTP surface has zero executed integration coverage.**

## 7. Authz-contract coverage — which routes are pinned

`apps/api/src/common/guard-contract.test.ts` declares itself the single source of truth for guards on every route (`:52-62`). Measured against the 42 payer routes:

**PINNED (19 routes / 6 controllers):** `PayerAuthController` (5, `:216-220`), `PayerUnlocksController` (8, `:227-239`), `PayerCapacityController` (2, `:250-254`), `PayerReachController` (1, `:255`), `MatchSkillsController` (2, `:260-264`), `PayerPricingController` (1, `:268`).

**NOT PINNED (23 routes / 6 controllers — 55%):**

| Controller | Routes | Imported in guard-contract.test.ts? |
|---|---|---|
| `PayerAccountController` | `GET`/`PATCH /payer/me` | **no** (grep count 0) |
| `PayerJobPostingsController` | all 10 incl. `:id/plan`, `:id/boost`, `:id/quota-topup` | **no** |
| `PayerDisclosureController` | `POST`/`GET /payer/resume-disclosures` | **no** |
| `PayerOrgMembersController` | 3 | **no** |
| `PayerOrgInvitesController` | 1 | **no** |
| `JobPostingChatController` | 5 | **no** |

Compounding: `PayerRoleGuard` is a **no-op when `@PayerRoles` is absent** (`apps/api/src/payers/payer-role.guard.ts:43`). Losing the class-level `@UseGuards(PayerAuthGuard)` on `PayerJobPostingsController` — the money surface — would make it fully public with **every test in the repo still green**.

## 8. (f) Payments trace — mock vs real, and prod reachability

### Path A — `POST /payer/credits` (mock)

```
PayerUnlocksController.buyPack            payer-unlocks.controller.ts:129-139
  → UnlockService.purchaseCredits         unlocks.service.ts:515-538
      → PaymentGateway.resolvePack        payment-gateway.ts:133-136   (live catalog, else CREDIT_PACKS constant)
      → PaymentGateway.purchasePackMock   payment-gateway.ts:166-181
          → UnlocksRepository.creditPack  unlocks.repository.ts:407    (balance += credits; ledger row appended atomically,
                                                                        reason "pack_purchase", paymentRef NULL, priceInr stamped)
      → emitPaymentAuthorized(real_call:false)  unlocks.service.ts:527
      → emitPaymentCaptured(real_call:false)    unlocks.service.ts:532
```

Balance: `payer_credits.balance += pack.credits`. Ledger: one `credit_ledger` row, `delta = +credits`, `pack_code`, `price_inr` stamped, `payment_ref = NULL`. **No money is collected.**

**Reachable in production? YES.** The only gate is the class-level `PayerAuthGuard` (`:47`). Grepping every caller of `purchaseCredits` / `purchasePackMock` across `apps/api/src` returns exactly the payer controller, the ops controller, the service, and the gateway — **no `PAYMENTS_ENABLE_REAL` check, no `NODE_ENV` check, no kill-switch**. `realPaymentsBlockedReason` (`packages/config/src/server.ts:1132-1139`) and `assertPaymentsConfig` (`:1297-1307`) gate only the *real* path. Contrast `POST /payer/credits/order` and `/verify`, which open with `if (!this.unlocks.realPaymentsLive) throw new NotFoundException()` (`payer-unlocks.controller.ts:164`, `:198`).

Consequence: with `PAYMENTS_ENABLE_REAL=true` and Razorpay wired, `POST /payer/credits {"pack_code":"pack_50"}` still grants 50 credits free, repeatable without limit (no idempotency key on the mock path — `payment-gateway.ts:175`, "no external order id in the mock path"). Any authenticated active payer can drain the unlock economy.

### Path B — `POST /payer/credits/order` → checkout → `/verify` + webhook (real)

```
createOrder      payer-unlocks.controller.ts:157-177   ← neutral 404 unless realPaymentsLive
  → UnlockService.createCreditOrder      unlocks.service.ts:565-584
      → resolvePack (same catalog path — the client never names a price)
      → PaymentGateway.createRealOrder   payment-gateway.ts:202   (Razorpay order; grant size STAMPED on the order row)
      → emitPaymentAuthorized(real_call:true, key `payment.authorized:order:<rowId>`)

verify           payer-unlocks.controller.ts:191-217   ← neutral 404 unless realPaymentsLive
  → verifyCheckoutPayment                unlocks.service.ts:602-654
      → getRazorpayCredentials → {verified:false} if absent            :610-611
      → verifyCheckoutSignature (constant-time HMAC over order|payment) :613-617
      → settleAndEmit({providerOrderId, providerPaymentRef, expectedPayerId: payerId})  :619-628
          → PaymentGateway.settleOrder   payment-gateway.ts:264   (claim the order row paid in a tx, credit the pack)
          → emitPaymentCaptured ONLY on "granted", key `payment.captured:order:<id>`  unlocks.service.ts:726-734
          → alertIfPayerSuspended (fail-OPEN by design, :761-772)
```

The webhook (`POST /payments/razorpay/webhook`, `RazorpayWebhookGuard`) converges on the **same** `settleAndEmit` with no `expectedPayerId` (`unlocks.service.ts:691-701`). Whichever channel lands first grants; the other returns `already_settled` and reports the authoritative balance as a success (`:639-650`), so a paying customer on a flaky network is never told their purchase failed. `credits: 0` on an `already_settled` verify is a **success**, documented at `payer-api.ts:378-380`.

### The rest of the money surface has the same hole as Path A

`buyPlanForPayer` (`posting-plans.service.ts:259` → `buyPlan:177`), `buyBoostForPayer` (`:272` → `buyBoost:281`), `topUpQuotaForPayer` (`:365`) and `buyCapacity` (`:432`) all compute `const realCall = areRealPaymentsEnabled(this.config)` **purely to stamp the event honestly** (`:186`, `:306`, `:376`, `:438`) and then grant unconditionally. There is no Razorpay path for plans, boosts, quota top-ups or capacity at all — four more paid products free for the taking in production, and `POST /payer/capacity` in particular raises the concurrent-vacancy allowance and auto-resumes paused plans.

### Frontend reachability of the payment surface

All three payment Server Actions call `requireOwner()` first (`credits/actions.ts:38`, same on `createOrderAction`/`verifyPaymentAction`), which resolves through `getOrgRole()` (`apps/payer-web/src/lib/auth/org-roles.ts:46-56`) — that function **hard-returns `"recruiter"` outside dev** because the signed session carries no org-role claim, so `requireOwner()` calls `notFound()` (`:64-70`) for **every** staging/production user. The backend already has the authoritative role (`PayerOrgRoleGuard` resolves `payer_members.org_role` per request, `payer-org-role.guard.ts:64+`); the web session simply never carries it. Net: the money-in loop and the team loop are dead on payer-web while the endpoints behind them stay open to any direct API caller.

## 9. Vertical authz asymmetry

`grep -rn "@PayerRoles" apps/api/src` returns **only `@PayerRoles("agent")`** — `AgencyJobsController:36`, `AgencyInvitesController:36`, `AgencyPayoutsController:22`, `AgencyWorkersController:26`. There is **no `@PayerRoles("employer")` anywhere**, and `PayerRoleGuard` is not applied to any payer-portal controller. An `agent`-role payer therefore holds a valid session for the entire employer surface: create company postings, spend credits, buy plans/boosts/capacity, read reach. Whether intended is not decidable from the code — recorded as an ambiguity.

## 10. Rate-limit coverage map

| Surface | Limiter | Where |
|---|---|---|
| public auth (signup/login-request/login-verify) | `IpRateLimit.assertWithinHourlyIpCap("payer_auth", ip, PAYER_AUTH_MAX_PER_IP_PER_HOUR)` | `payer-auth.controller.ts:95-101` |
| unlock request + reveal | `PayerDisclosureRateLimit.assertWithinHourlyCap(payerId)` (XB-G) | `payer-unlocks.controller.ts:68`, `:89` |
| resume disclosure request | same limiter | `payer-disclosure.controller.ts:59` |
| reach applicants | same limiter, scope `payer_reach`, cap `PAYER_REACH_MAX_PER_HOUR` | `payer-reach.controller.ts:69-72` |
| **job-posting create/update/plan/boost/quota-topup** | **none** | `payer-job-postings.controller.ts` — no limiter imported |
| **capacity buy** | **none** | `payer-capacity.controller.ts` |
| **credit pack buy** | **none** | `payer-unlocks.controller.ts:129` |
| **AI chat message** | **none** | `job-posting-chat.controller.ts:56`; `job-posting-chat.service.ts` has no cap/throttle symbol at all |

Every money-mutating and AI-spending payer route is unthrottled.
