# Security & Authorization Audit — Payer + Agency

**Status:** COMPLETE (audited 2026-08-11, dimension re-run after the usage-limit interruption).
**Method:** evidence-based static analysis; every claim carries a `file:line` citation.
**Findings feed** `GAP_REGISTER.md`. Coverage caveats: `AUDIT_STATUS.md`.

---

# Authentication, Authorization & Security — payer + agency surface

## Executive summary
I enumerated all 16 payer/agency controllers in apps/api (58 routes) and read the service + repository behind every route that accepts an `:id` or a body-supplied id. Object-level authorization is genuinely strong: of 22 object-level routes, 21 are SCOPED with the owner id inside the SQL WHERE (not a post-filter), and every miss resolves to the same neutral 404 rather than a 403 — I found ZERO IDOR/BOLA on the shipped surface. Never-trust-body-ids also holds: no payer/agency DTO carries payer_id/org_id (only the InternalServiceGuard-protected ops DTOs do), and apps/payer-web's transport physically cannot send one. PII posture is the strongest part of the codebase: the reveal path returns an opaque relay handle, there is exactly one decrypt() on the unlock path (CI-enforced), and the agency surface is HMAC-pseudonymized per-agency. The three unauthenticated leaks recorded in an earlier audit (PUT /pricing/catalog, GET /job-postings, GET /events) are all now behind InternalServiceGuard, which fails closed when unconfigured. Against that, the org-RBAC dimension is where the real damage is: @OrgRoles is applied to exactly ONE controller (/payer/org/members), so 11 SPEND routes — the entire wallet, capacity, plan/boost/quota-topup and agency KYC/payout surface — carry only PayerAuthGuard and have NO server-side Owner enforcement at all. Today that is latent because credits are per-payer; the moment org tenancy lands it is live privilege escalation. Worse, the only Owner check in the whole system is apps/payer-web/src/lib/auth/org-roles.ts:46-56, a stub that hard-returns "recruiter" outside dev — so requireOwner() currently denies EVERY real user, which both makes /credits and /team unreachable 404s in production and means the Owner gate has never actually run against a real principal. Three structural weaknesses compound this: payer-scope.ts, the documented "tenant-isolation chokepoint", has exactly ONE consumer (agency.service.ts) while nine other repositories hand-roll ~30 independent payer predicates; guard-contract.test.ts — self-described as "the single source of truth for which guards protect every route" — omits six payer/agency controllers including the entire /payer/job-postings money surface; and the only HTTP-level cross-tenant test, tests/e2e/payer-tenancy.e2e.test.ts:93, is a hard describe.skip. On session hygiene: payer-auth.guard.ts correctly re-reads payers.status per request (suspension bites immediately), but it never reads payer_members.status, and removing an org member does not revoke their sessions — a removed recruiter's 30-day JWT stays fully live. Finally, resolveOrgForPayer assumes one active membership and takes "most-recently-accepted wins", but ensureSoloOrg guarantees every payer already has a solo-org membership, so EVERY invited teammate has 2+ active memberships by construction — the assumption is already violated in normal operation. Counts: 22 object-level routes audited (21 scoped, 1 deliberately unscoped-but-benign); 11 spend routes needing an Owner gate; 0 CREATE POLICY statements against 64 RLS-enabled tables; 0 security headers on either app.

> Audit date 2026-08-11 · branch `feat/747a-spoken-digit-redaction` (≡ origin/main − 1) · READ-ONLY.
> Every claim below was produced by opening the implementation file, not by inferring from a route, type, or test name.

---

# 1. Object-level authorization (IDOR / BOLA) — per-route verdict

`apps/api/src/payers/payer-scope.ts:18-47` defines three helpers (`assertPayerOwns`, `assertOwnedRows`, `readOwnedById`). **Only `apps/api/src/agency/agency.service.ts` imports them** (`agency.service.ts:14`, used at `:206` and `:755`). Every other payer surface implements its own owner predicate directly in the repository `WHERE`. That is *not* a vulnerability today — I read each one and all of them scope correctly — but see §5 (PAY-SEC-05) for why it matters.

## 1.1 `/payer/job-postings/*` — `apps/api/src/payer-portal/payer-job-postings.controller.ts`

Class guards: `@UseGuards(PayerAuthGuard)` only (`:66`). No `@PayerRoles`, no `@OrgRoles`.

| Route | Handler | Verdict | Proof |
|---|---|---|---|
| `POST /payer/job-postings` | `create:87-95` | SCOPED | `payer.id` from `@CurrentPayer` → `createForPayer` stamps `payerId` + `createdBy` (`job-postings.service.ts:234-255`); status forced `draft` (`:479`) so a client-supplied status is ignored |
| `GET /payer/job-postings` | `list:105-112` | SCOPED | `repo.listByPayer(payerId, status)` (`job-postings.service.ts:257-259`) |
| `GET /payer/job-postings/:id` | `getOne:115-122` | SCOPED | `repo.findByIdAndPayer(id, payerId)` → neutral 404 (`job-postings.service.ts:262-266`) |
| `PATCH /payer/job-postings/:id` | `update:125-134` | SCOPED | `getOneForPayer` first, then `repo.updateOwned(id, payerId, patch)` (`:274-281`) — owner in the UPDATE `WHERE`, not only in the pre-read |
| `POST /:id/close` | `close:137-145` | SCOPED | `getOneForPayer` + `repo.closeOwned(id, payerId, …)` (`:294-303`) |
| `POST /:id/pause` | `pause:148-156` | SCOPED | `getOneForPayer` + `repo.transitionOwned(id, payerId, "open", "paused")` (`:311-324`) |
| `POST /:id/resume` | `resume:159-167` | SCOPED | `getOneForPayer` + `repo.transitionOwned(id, payerId, "paused", "open")` (`:331-343`) |
| `POST /:id/plan` | `buyPlan:177-187` | SCOPED (controller-level only) | `await this.jobPostings.getOneForPayer(id, payer.id)` at `:185` — but `PostingPlansService.buyPlan` itself never re-checks the posting owner (see PAY-SEC-13) |
| `POST /:id/boost` | `buyBoost:194-204` | SCOPED (controller-level only) | same shape, `:202` |
| `POST /:id/quota-topup` | `topUpQuota:215-225` | SCOPED (defence-in-depth) | `:223` ownership pre-read **and** `findActivePlanForPostingAndPayer(jobPostingId, payerId, now)` inside `topUpQuotaForPayer` (`posting-plans.service.ts:381`) |

## 1.2 `/payer/unlocks/*` + `/payer/credits/*` — `apps/api/src/payer-portal/payer-unlocks.controller.ts`

Class guards: `@UseGuards(PayerAuthGuard)` only (`:47`).

| Route | Handler | Verdict | Proof |
|---|---|---|---|
| `POST /payer/unlocks` | `requestUnlock:61-73` | SCOPED | `{ payerId: payer.id, workerId: dto.worker_id … }` — body carries only `worker_id`/`job_id` (`payer-unlocks.dto.ts:7`) |
| `POST /payer/unlocks/:unlockId/reveal` | `reveal:82-91` | SCOPED (no-oracle) | `unlocks.service.ts:332` — `if (pre && expectedPayerId !== undefined && pre.payer_id !== expectedPayerId) return neutralUnavailable();` — a foreign unlock gets the **byte-identical** 200 neutral body, never a 403 |
| `GET /payer/unlocks` | `listOwn:94-97` | SCOPED | `listByPayer(payer.id)` |
| `GET /payer/credits` | `ownCredits:100-103` | SCOPED | `getCredits(payer.id)` |
| `GET /payer/credits/ledger` | `creditsLedger:111-117` | SCOPED | `getCreditLedger(payer.id, limit)` |
| `POST /payer/credits` | `buyPack:129-139` | SCOPED | pack CODE only; price resolved server-side from config |
| `POST /payer/credits/order` | `createOrder:157-177` | SCOPED | `createCreditOrder(payer.id, dto.pack_code, ctx)`; no amount/currency on the wire (`razorpay-webhook.dto.ts:77`) |
| `POST /payer/credits/verify` | `verifyPayment:191-217` | SCOPED (no-oracle) | ownership enforced inside `settleAndEmit` via `expectedPayerId` (`unlocks.service.ts:619-628`); forged signature / unknown order / other tenant's order all return the SAME 404 |

## 1.3 `/payer/reach/*` — `apps/api/src/payer-portal/payer-reach.controller.ts`

| Route | Verdict | Proof |
|---|---|---|
| `GET /payer/reach/jobs/:jobId/applicants` | SCOPED, **two different tables by flag** | Legacy path: `reach.applicantsForOwnedJob(jobId, payerId)` → `findOwnedJobSignalRowById` with `and(eq(jobs.id,…), eq(jobs.payerId,…))` (`reach.repository.ts:183-193`). MATCH_V1 path (`payer-reach.controller.ts:74-82`): `jobPostings.getOneForPayer(params.jobId, payer.id)` — a **different table** (`job_postings`), then `matchCandidates.listForPosting(jobId)` which has NO scoping of its own (`match-candidates.service.ts:70-97`). Authz holds either way, but see PAY-SEC-15. |

## 1.4 `/payer/agency/*` — `apps/api/src/agency/*`

Class guards: `@UseGuards(PayerAuthGuard, PayerRoleGuard)` + `@PayerRoles("agent")` on all four controllers (`agency-jobs.controller.ts:32-33`, `agency-invites.controller.ts:35-36`, `agency-workers.controller.ts:25-26`, `agency-payouts.controller.ts:21-22` which adds `AgencyPayoutsEnabledGuard`).

| Route | Verdict | Proof |
|---|---|---|
| `POST /payer/agency/jobs` | SCOPED | `agency.service.ts:153-158`, `payerId` stamped from session; `agency.dto.ts:18,126` — `payer_id` is not a DTO field |
| `GET /payer/agency/jobs` | SCOPED ×2 | `jobsRepo.listOwned(payerId)` (`agency-jobs.repository.ts:114-120`) **plus** `assertOwnedRows` (`agency.service.ts:206`) |
| `GET /payer/agency/jobs/:jobId` | SCOPED ×2 | `findOwnedById(jobId, payerId)` (`agency-jobs.repository.ts:104-111`) wrapped in `readOwnedById` (`agency.service.ts:754-761`) |
| `PATCH /payer/agency/jobs/:jobId` | SCOPED ×2 | pre-read + `updateOwned(jobId, payerId, patch)` — owner in the UPDATE `WHERE` (`agency-jobs.repository.ts:126-133`) |
| `POST /:jobId/close`, `/:jobId/pause` | SCOPED ×2 | `closeOwnedIfOpen(jobId, payerId, now)` — owner **and** expected status in the `WHERE` (`agency-jobs.repository.ts:140-147`) |
| `POST /payer/agency/invites`, `/invites/batch` | SCOPED | `inviterPayerId: payerId` from session (`agency.service.ts:517-523`) |
| `POST /payer/agency/invites/:code/click` | **UNSCOPED — deliberately** | `agency.service.ts:616-618` states "This is NOT owner-scoped". Agent A can advance agent B's invite `created→clicked` and emit `agency_invite.clicked` carrying B's `inviter_payer_id` (`:636-649`). Mitigated: a 48-bit code, an identical `{ok:true}` for unknown codes (no oracle), and a **public** equivalent already exists at `POST /invites/:code/click`. → P3, see PAY-SEC-19 |
| `GET /payer/agency/referrals/summary` | SCOPED + k-anon | `stageCountsForOwner(payerId)` + floor of 5 (`agency.service.ts:736-745`) |
| `GET /payer/agency/workers` | SCOPED + consent + pseudonymised | `agency-workers.service.ts:60-104`; per-agency HMAC `agency_worker:${payerId}:${workerId}` at `:68` |
| `POST/GET /payer/agency/kyc`, `/earnings`, `/payouts` | SCOPED | session `payer.id` only (`agency-payouts.controller.ts:30-74`) |

## 1.5 `/payer/org/members/*` — `apps/api/src/payer-portal/payer-org-members.controller.ts`

Class guards: `@UseGuards(PayerAuthGuard, PayerOrgRoleGuard)` (`:34`). **The only place `@OrgRoles` is used repo-wide.**

| Route | Verdict | Proof |
|---|---|---|
| `GET /payer/org/members` | SCOPED (any member) | `listMembers(org.orgId)` (`payer-orgs.repository.ts:108-114`); emails decrypted then **masked** (`payer-org-members.service.ts:241`) |
| `POST /payer/org/members` | SCOPED + `@OrgRoles("owner")` (`:46`) | org from `@CurrentOrg`, never body; seat cap `MEMBER_INVITE_MAX_PER_ORG` (`payer-org-members.service.ts:94-96`) |
| `DELETE /payer/org/members/:id` | SCOPED + `@OrgRoles("owner")` (`:59`) | `softRemoveMember(orgId, memberId)` — `and(id, orgId, orgRole='recruiter', status<>'removed')` in the UPDATE `WHERE` (`payer-orgs.repository.ts:259-273`); owners cannot be removed |
| `POST /payer/org/invites/accept` | SCOPED to token+identity | `PayerAuthGuard` only by design (`payer-org-invites.controller.ts:18`); accept bound to the caller's own email (`payer-org-members.service.ts:158-173`), token single-use via a guarded UPDATE (`payer-orgs.repository.ts:225-250`) |

## 1.6 `/payer/job-posting-chat/*` — `apps/api/src/payer-portal/job-posting-chat/job-posting-chat.controller.ts`

| Route | Verdict | Proof |
|---|---|---|
| `POST /session` | SCOPED | `createSession(payer.id)` |
| `POST /message` (body `session_id`) | SCOPED | `requireLiveSession(dto.session_id, payerId)` → `findOwnedSession` with owner in the predicate (`job-posting-chat.service.ts:169`, repo `:55-70`) |
| `GET /sessions` | SCOPED | `listSessions(payerId)` (repo `:77-91`) |
| `GET /sessions/:id/messages` | SCOPED | `requireOwnedSession` BEFORE `chat.listMessages(sessionId)` (`service:334-336`). The repo's `listMessages` is itself owner-blind (`repo:103-114`) — safe only because the service gates it first |
| `POST /sessions/:id/publish` | SCOPED + race-safe | `requireOwnedSession` (`service:390`), then `claimForPublish` with owner + `status <> 'published'` in the UPDATE `WHERE` (`repo:170-187`) |

## 1.7 Other

| Route | Verdict |
|---|---|
| `GET/PATCH /payer/me` (`payers/payer-account.controller.ts:28,42`) | SCOPED — id from `@CurrentPayer` only; `PayerUpdateSchema` is `.strict()` so a body `payer_id`/`role` is a 400 |
| `GET/POST /payer/capacity` (`payer-capacity.controller.ts:33,44`) | SCOPED — no `:payerId` param exists on this controller |
| `GET /payer/pricing/catalog`, `GET /payer/match/skills`, `POST /payer/match/reach-preview` | No tenancy surface (global config / supply counts) |
| `POST/GET /payer/resume-disclosures` (`payer-disclosure.controller.ts:52,67`) | SCOPED — `payerId: payer.id` |

**Verdict for §1: 22 object-level routes, 21 SCOPED, 1 deliberately unscoped-but-benign. No P0 IDOR found.**

---

# 2. Never-trust-body-ids

I grepped every payer/agency DTO for `payer_id` / `org_id`:

- `payer-disclosure.dto.ts:6`, `payer-unlocks.dto.ts:7,21,31`, `agency.dto.ts:18,126,302`, `posting-plans.dto.ts:37-40,49,77`, `razorpay-webhook.dto.ts:77` — all explicitly state and enforce "no `payer_id` field".
- The only DTOs carrying `payer_id` are **ops-only**: `posting-plans.dto.ts:11,29` (`BuyPlanSchema`/`BuyBoostSchema`, behind `InternalServiceGuard` at `posting-plans.controller.ts:23`) and `unlocks.dto.ts:20,32` (behind `InternalServiceGuard`). `agency-kyc-ops.dto.ts:5` takes `payerId` as a path param, also `InternalServiceGuard`.
- `posting-plans/capacity.controller.ts:20-33` takes `@Param("payerId")` — **advisory by design**, documented at `:13-18`, `InternalServiceGuard` only.
- Frontend: `apps/payer-web/src/lib/payer-http.ts:34-35` — "NEVER include a payer_id"; the transport has no code path that sends one. `payer-api.ts:322,515` send `{pack_code}` / `{tier}` only.

**No defect.**

---

# 3. `@PayerRoles` coverage and the employer↔agent asymmetry

`PayerRoleGuard` is a **no-op when metadata is absent** (`payer-role.guard.ts:59-60`). Inventory:

| Controller | `PayerRoleGuard` attached? | `@PayerRoles`? |
|---|---|---|
| AgencyJobs / AgencyInvites / AgencyWorkers / AgencyPayouts | yes | yes, class-level `("agent")` — every route covered |
| PayerJobPostings, PayerUnlocks, PayerCapacity, PayerPricing, PayerReach, PayerDisclosure, PayerAccount, PayerOrgMembers, PayerOrgInvites, JobPostingChat, MatchSkills | **no guard at all** | n/a |

So there is **no controller that attaches `PayerRoleGuard` and then forgets `@PayerRoles`** — the classic footgun is not currently triggered. But the consequence is a one-way asymmetry:

- an `employer` session hitting `/payer/agency/*` → 403 (`agency-role-authz.test.ts` proves it against the real controllers);
- an `agent` session hitting the **entire company surface** (`/payer/job-postings`, `/payer/unlocks`, `/payer/credits`, `/payer/capacity`, `/payer/reach`, `/payer/job-posting-chat`) → **allowed**.

`apps/payer-web/src/lib/auth/roles.ts:6-13` states this is intentional ("The DEMAND loop … is SHARED by both roles"). Corroborating: `requireEmployer` is defined at `roles.ts:42-44` and **is never called anywhere in `apps/payer-web/src/app`** — only its own test references it. So the design is "agencies are also demand-side buyers". I record it as by-design; no ADR file exists on main to confirm it (see Ambiguity A). The residual defect is that a *dead* `requireEmployer` gate invites a future author to assume company-only gating exists.

Also note: **role is self-elected at signup.** `PayerSignupSchema` (`payer-auth.dto.ts:14-21`) accepts `role: "employer" | "agent"` from an unauthenticated body, and `payer-auth.service.ts:71` writes it straight to the row. Anyone can create an `agent` account and reach the whole agency surface. The money half is inert behind `AGENCY_PAYOUTS_ENABLED` (default false) via `AgencyPayoutsEnabledGuard` (`agency-payouts-enabled.guard.ts:17-23`, neutral 404).

---

# 4. Org RBAC — the headline finding (audit question #4)

## 4.1 What exists today

- `@OrgRoles` + `PayerOrgRoleGuard` are applied to **exactly one controller**: `PayerOrgMembersController` (`payer-org-members.controller.ts:34,46,59`).
- The frontend asserts the org model in three places: `org-roles.ts:16` ("Owner → billing/wallet (credits) + user management (team)"), `credits/page.tsx:49` (`requireOwner()`), `team/page.tsx:17` (`requireOwner()`), and re-asserted in the write actions (`credits/actions.ts:42,90,126`; `team/actions.ts:27,38`).
- **The backend enforces none of it.** `PayerUnlocksController` (`payer-unlocks.controller.ts:47`) and `PayerCapacityController` (`payer-capacity.controller.ts:23`) carry `@UseGuards(PayerAuthGuard)` and nothing else.

**Can a Recruiter session `curl POST /payer/credits` and spend the org's money?** Today: they can call it and it succeeds — but the credits it mints land on *their own* `payer_credits` row (`unlocks.service.ts` `purchaseCredits(payer.id, …)`), so there is no shared balance to steal. The answer is therefore *"yes, the call succeeds; no, nothing is stolen — yet."* The frontend 404 is cosmetic and, worse, it is currently a **permanent deny** (§4.2).

## 4.2 The Owner gate has never run

`apps/payer-web/src/lib/auth/org-roles.ts:38` carries a `// STUB:` marker; `getOrgRole()` at `:46-56` runs a dev-only override then hard-returns `"recruiter"`. `isDevEnv()` reads raw `NODE_ENV`, so in staging/production the override branch is dead. Therefore `requireOwner()` (`:64-70`) calls `notFound()` for **every** real principal. Consequences:

1. `/credits` and `/team` are unreachable 404s for every staging/production user.
2. `topUpAction`, `createOrderAction`, `verifyPaymentAction`, `inviteMemberAction`, `removeMemberAction` all `await requireOwner()` **first** and therefore refuse unconditionally — the entire billing loop and the entire team-management loop are dead in production.
3. Security-wise: the only Owner authorization in the system is a client-app function that has never evaluated a real Owner. When it is wired correctly, the frontend gate becomes real and the backend gate is still absent.

## 4.3 (a) Definitive list of routes needing an Owner gate before org tenancy lands

### SPEND — must be Owner (org wallet / org commercial commitment)

| # | Route | File:line | Today's guards | Why Owner |
|---|---|---|---|---|
| 1 | `POST /payer/credits` | `payer-unlocks.controller.ts:129-139` | `PayerAuthGuard` | Mints credits onto the wallet. The frontend already claims this is Owner-only (`credits/actions.ts:31`) |
| 2 | `POST /payer/credits/order` | `:157-177` | `PayerAuthGuard` | Starts a REAL Razorpay order against the org |
| 3 | `POST /payer/credits/verify` | `:191-217` | `PayerAuthGuard` | Settles a payment and grants credits |
| 4 | `POST /payer/capacity` | `payer-capacity.controller.ts:43-51` | `PayerAuthGuard` | Raises the org's concurrent-vacancy allowance — a recurring commercial commitment, not an operational act |
| 5 | `POST /payer/agency/kyc` | `agency-payouts.controller.ts:30-37` | `PayerAuthGuard, PayerRoleGuard(agent), AgencyPayoutsEnabledGuard` | Submits the ORG's PAN + bank account. Financial identity — must not be a recruiter's to set |
| 6 | `POST /payer/agency/payouts` | `:57-61` | same | Requests money OUT of the org |

### SPEND — genuinely ambiguous, my reasoning and recommendation

| # | Route | File:line | My call | Reasoning |
|---|---|---|---|---|
| 7 | `POST /payer/job-postings/:id/plan` | `payer-job-postings.controller.ts:177-187` | **Owner** | Choosing a price TIER is a purchase decision, not an operational one. A recruiter can draft and publish; committing the org to a tier is procurement |
| 8 | `POST /payer/job-postings/:id/boost` | `:194-204` | **Owner** | Same class as (7) — a discretionary paid upgrade |
| 9 | `POST /payer/job-postings/:id/quota-topup` | `:215-225` | **Member, with a per-member cap** | This is "I've run out of applicant views on the req I own" — refusing it blocks the recruiter's actual job. Gating it on Owner turns every busy day into a ticket. But it spends, so it needs a budget, not a role |
| 10 | `POST /payer/unlocks` | `payer-unlocks.controller.ts:61-73` | **Member, with a per-member cap** | Unlocking a candidate IS the recruiter's day job and the product's core loop. Making it Owner-only would make the product unusable for teams. It already carries a per-payer hourly cap (`:68`) which becomes the natural place to hang a per-member org budget |
| 11 | `GET /payer/credits/ledger` | `:111-117` | **Owner** (READ, but billing history) | The ledger is the org's full spend history. The balance is operational; the history is finance |

### READ — any active member (no `@OrgRoles` needed, but MUST gain the org predicate)

`GET /payer/credits` (balance only — a recruiter must know whether an unlock will succeed), `GET /payer/unlocks`, `GET /payer/capacity`, `GET /payer/job-postings` + `/:id`, `GET /payer/reach/jobs/:jobId/applicants`, `GET /payer/pricing/catalog`, `GET /payer/match/skills`, `POST /payer/match/reach-preview`, `GET/POST /payer/resume-disclosures`, all `/payer/job-posting-chat/*`, `GET /payer/agency/jobs*`, `GET /payer/agency/workers`, `GET /payer/agency/referrals/summary`, `GET /payer/agency/earnings`, `GET /payer/agency/payouts`, `GET /payer/org/members`.

### Must stay PAYER-scoped, never org-scoped

`GET /payer/me`, `PATCH /payer/me` (`payer-account.controller.ts:28,42`) — a person's own account, and `PATCH /payer/me` edits their own contact phone. `POST /payer/refresh`, `POST /payer/logout`, `POST /payer/org/invites/accept`.

## 4.4 (b) Where an org-scoped rewrite could introduce a NEW authz bug

**B1 — routes that would need org resolution they do not have today.** `PayerOrgRoleGuard` is attached to ONE controller. Every one of the other 15 payer/agency controllers has no `req.payerOrg` at all. Attaching the guard to all of them changes its own documented assumption: `payer-org-role.guard.ts:57-60` says "This is a LOW-FREQUENCY surface (team management), so a per-request resolve is cheap; baking `org_id`/`org_role` into the session JWT is a deferred perf optimization". Once every route depends on it, that is one extra DB round-trip on **every** request on top of `PayerAuthGuard.findAuthFacts` (`payer-auth.guard.ts:106`). If the team responds by baking `org_id` into the JWT, the membership check becomes **stale for the life of the session** — exactly the failure mode `payer-auth.guard.ts:100-105` was written to avoid for `status`.

**B2 — routes where `org_id` would arrive from a body/query.** Two concrete hazards already in the tree:
- `posting-plans.dto.ts:11,29` — `BuyPlanSchema`/`BuyBoostSchema` already carry `payer_id: uuidSchema` as a **body field**, and `PostingPlansService.buyPlan` consumes `dto.payer_id` directly (`posting-plans.service.ts:204,213`). The payer path launders this via `buyPlanForPayer(jobPostingId, payerId, …)` → `buyPlan(jobPostingId, { payer_id: payerId, … })` (`:259-266`). A naive org rewrite that adds `org_id` to the same DTO shape reintroduces a client-supplied tenant id on a money route.
- `posting-plans/capacity.controller.ts:25-33` — `@Param("payerId")` is explicitly ADVISORY. Renaming it `:orgId` under the same guard keeps it advisory; it must not be reused for the payer path.

**B3 — repositories whose `WHERE` would silently widen.** ~30 payer predicates across 10 repositories:

| Repository | payer predicates | Widening consequence if `payer_id → org_id` without a membership constraint |
|---|---|---|
| `unlocks/unlocks.repository.ts` | 6 | Every member could **reveal** any worker the org ever unlocked — reveal opens a live relay to a real person. This is a PII widening, not just a visibility one |
| `job-postings/job-postings.repository.ts` | 6 | Any member could close/pause/edit any org posting. Probably intended, but it must be a decision |
| `payer-portal/job-posting-chat/job-posting-chat.repository.ts` | 6 | A recruiter's draft **conversation transcript** (free text they typed) becomes readable org-wide |
| `posting-plans/posting-plans.repository.ts` | 5 | Capacity + active-plan counting becomes org-wide; the advisory-lock key (`lockPayer`, `posting-plans.service.ts:447`) must become `lockOrg` or the concurrency guarantee breaks |
| `agency/agency-jobs.repository.ts` | 4 | agency demand rows go org-wide |
| `agency/agency-kyc.repository.ts` | 3 | KYC is per-`payer_id` today; org-scoping it means one member's PAN is the org's |
| `disclosures/resume-disclosure.repository.ts` | 3 | Masked-resume grants widen org-wide |
| `reach/reach.repository.ts` | 1 | `findOwnedJobSignalRowById` |
| `payers/payer-orgs.repository.ts` | 3 | already org-shaped |
| `agency/agency-workers.repository.ts` | (inviter scope) | **Data-integrity break, not authz**: the per-agency pseudonym is `hmac("agency_worker:${payerId}:${workerId}")` (`agency-workers.service.ts:68`). Swapping `payerId → orgId` silently re-keys **every** worker handle every agency has ever seen |

**B4 — `payer_members.status` is not on the auth path.** `PayerAuthGuard` re-reads `payers.status` per request and rejects anything but `active` (`payer-auth.guard.ts:106-118`). It does **not** read `payer_members.status`. `resolveOrgForPayer` does filter `eq(payerMembers.status, "active")` (`payer-orgs.repository.ts:97`) — but it only runs inside `PayerOrgRoleGuard`, i.e. on three routes. Removing a member (`softRemoveMember`, `payer-orgs.repository.ts:259-273`) sets `status='removed'` and **does not revoke sessions**: `revokeAllForPayer` (`payer-session.service.ts:241-254`) has exactly one caller, `admin-actions.service.ts:180` (suspend). So a removed recruiter keeps a fully valid 30-day JWT and, under org tenancy, would reach org data on every route that does not consult `PayerOrgRoleGuard`. **Required fix: fold the membership read into the same per-request read as `payers.status`, and call `revokeAllForPayer` on member removal.**

## 4.5 (c) Is `PayerOrgRoleGuard`'s fail-closed behaviour sufficient?

**As a gate: yes.** `payer-org-role.guard.ts:75` (401 on missing `req.payer`), `:84` (403 on no active membership), `:79-83` (resolve error → `org = null` → 403), `:94-97` (403 on role mismatch). That is correct fail-closed ordering and I found no bypass.

**Two things are NOT sufficient once every route depends on it:**

1. **The error is swallowed silently.** `catch { org = null }` at `:81-83` discards the exception with no log and no metric. On three low-traffic routes that is acceptable. On all 58, a DB blip becomes an org-wide 403 storm that is indistinguishable in the logs from legitimate "not a member" refusals. Add structured logging that distinguishes *refused* from *could-not-resolve* server-side, while keeping the client response identical.

2. **The single-active-membership assumption is ALREADY violated in normal operation.** `resolveOrgForPayer` (`payer-orgs.repository.ts:93-101`) does `.where(memberPayerId = X AND status='active').orderBy(desc(acceptedAt)).limit(1)` — "most-recently-accepted wins", documented at `:88-89` as "B5: one org per member". But `ensureSoloOrg` (`payer-orgs.repository.ts:52-85`) is called at signup **and defensively at every login** (`payer-auth.service.ts:91` and `:148`) and creates an `active` owner membership in the payer's own solo org with `acceptedAt = now`. So the moment an existing payer accepts an invite to another org (`acceptInvite`, `payer-orgs.repository.ts:225-250`, sets `acceptedAt = now`), they have **two active memberships**. Every invited teammate is in this state by construction. Consequences under org tenancy:
   - Which tenant the payer acts in is decided implicitly by an `ORDER BY`, not by the payer and not by the request.
   - Their own solo org becomes permanently unreachable — they can never manage it again.
   - Any resources they created before joining become orphaned relative to their current org context.
   - If they are later removed from org B, `resolveOrgForPayer` silently falls back to their solo org A — a *different tenant* — with no re-authentication.

   **This must be resolved before org tenancy lands.** Either (i) enforce a hard one-active-membership invariant at accept time (deactivate the solo membership, with a documented rule for what happens to its rows), or (ii) make the acting org an explicit, server-validated part of the session (re-minted on an explicit org switch), never an implicit `ORDER BY`.

---

# 5. Server Actions as an attack surface (audit question #5)

Every `"use server"` function in `apps/payer-web` is an independently invocable POST endpoint. 18 modules; 16 export actions.

| Module | Actions | Session re-derived? | Verdict |
|---|---|---|---|
| `login/actions.ts` | requestCode, signup, verifyCode | n/a (public) | Correct — neutral errors, no enumeration, OTP never returned (`:40,84`) |
| `(portal)/credits/actions.ts` | topUp, createOrder, verifyPayment | **`requireOwner()` FIRST** (`:42,90,126`) | Correct, gate-before-validation, order asserted by test |
| `(portal)/team/actions.ts` | invite, remove, accept | `requireOwner()` (`:27,38`), `requirePayer()` (`:48`) | Correct |
| `(portal)/capacity/actions.ts` | upgradeCapacity | `requirePayer()` (`:33`) | Correct for today; needs Owner under org tenancy (§4.3 #4) |
| `(portal)/agency/dashboard/{invite,batch-invite,jobs}-actions.ts` | 6 actions | `requireAgent()` FIRST on every one (`invite-actions.ts:64`, `batch-invite-actions.ts:93`, `jobs-actions.ts:59,77,98,115`) | Correct |
| `(portal)/agency/referrals/supply-actions.ts` | submitKyc, requestPayout | `requireAgent()` (`:39,72`) | Correct role gate; **no Owner gate** on a KYC/payout write (§4.3 #5-6) |
| `(portal)/postings/actions.ts` | pause, resume, **topUpQuota**, close | **NO gate** — relies on the seam | See below |
| `(portal)/postings/new/actions.ts`, `new/match-actions.ts`, `ai/new/actions.ts`, `[id]/edit/actions.ts`, `[id]/applicants/actions.ts`, `account/actions.ts` | 10 actions | **NO gate** — rely on the seam | See below |
| `(portal)/logout-action.ts` | logout | n/a | Fine |

**Is the un-gated group exploitable?** No, not today. `payerFetch` reads the httpOnly cookie and throws `PayerUnauthorizedError` when absent (`payer-http.ts:48-51`), and every backend route is `PayerAuthGuard`-protected and owner-scoped. **None of them trusts a client-supplied id without re-scoping** — the ids they forward (`postingId`, `workerId`, `unlockId`, `sessionId`) are all re-scoped server-side (§1). The residual concern is `topUpQuotaAction` (`postings/actions.ts:74-98`): it **spends money** and has no gate in either layer — not in the action, not on the API route. That is the concrete instance of PAY-SEC-01 reachable from the browser today.

**CSRF.** Next 15.1.4 (`apps/payer-web/package.json:20`) applies the built-in Server Action Origin↔Host check by default. `apps/payer-web/next.config.mjs` (whole file, 11 lines) sets **no** `experimental.serverActions.allowedOrigins`, so the default is what protects the app. Combined with `sameSite: "lax"` (`session-cookie.ts:42`), a cross-site POST is blocked. There is no test asserting this and no documented reverse-proxy host contract — a proxy that rewrites `Host` without setting `X-Forwarded-Host` will break every action.

---

# 6. Session / auth lifecycle (audit question #6)

| Property | Status | Evidence |
|---|---|---|
| Cookie httpOnly | Yes | `session-cookie.ts:41` |
| Cookie SameSite | `lax` | `:42` |
| Cookie Secure | **Heuristic, fails OPEN** | `shouldUseSecureCookie()` `:24-37` — true only if `NODE_ENV=production` OR `NEXT_PUBLIC_ENVIRONMENT ∈ {staging,production}` OR `NEXT_PUBLIC_SITE_URL`/`VERCEL_URL` is https. A staging deploy setting none of these issues the session cookie WITHOUT `Secure` |
| Token in client bundle | No | `session-cookie.ts:1` and `payer-http.ts:1` both `import "server-only"`; grep confirms `API_TOKEN_COOKIE_NAME` is referenced only in those two server-only modules |
| Suspension bites mid-session | **Yes, per request** | `payer-auth.guard.ts:106-118` — `findAuthFacts` every request; `status !== "active"` → 403. Deliberately not cached, reasoned at `:100-105`. Row missing → 401 (`:111`) fail-closed |
| Revoke-all on suspend | Yes | `payer-session.service.ts:241-254`, called from `admin-actions.service.ts:180`; **throws** on Redis failure so a failed revoke cannot be reported as enforced |
| Revoke on member removal | **NO** | `revokeAllForPayer` has no other caller. See PAY-SEC-03 |
| Logout revocation | Yes | `payer-auth.controller.ts:87-92` → `revoke(sid)` deletes the Redis record (`payer-session.service.ts:211-225`); best-effort, plus the frontend deletes the cookie (`http-provider.ts:141-150`) |
| Token expiry mid-session | **Rolling refresh is DEAD in the portal** | `payer-auth.guard.ts:127-133` mints a fresh JWT past the half-life and returns it in `x-session-token`. Grep across the whole repo: `x-session-token` appears **nowhere** in `apps/payer-web`. `POST /payer/refresh` also has no caller in `apps/payer-web`. So the cookie holds the original 30-day JWT (`SESSION_TTL_DAYS` default 30, `packages/config/src/server.ts:269`) for its whole life, never rotated, and the browser drops it at `maxAge = expires_in_seconds` (`http-provider.ts:110-115`) — an active user is logged out at day 30 |
| JWT audience pinning | Yes | `payer-session.service.ts:159-160` — `typ !== "payer"` → null; distinct Redis namespace `payer_session:` |
| OTP throttling | Yes, layered | per-IP hourly (`payer-auth.controller.ts:95-101`, default 20/h `server.ts:437`); per-account resend cooldown + hourly send cap; `OTP_MAX_ATTEMPTS` with code+counter deletion on exhaustion (`payer-otp.service.ts:160-173`); platform-wide daily email ceiling with a kill-switch at cap=0 (`:254-262`); constant-time compare; fail-closed on Redis |
| No-enumeration | Yes | signup and login/request return byte-identical `{status:"code_sent", resend_in_seconds}` (`payer-auth.dto.ts:36-45`); a non-existent account still walks the reserve path for timing parity (`payer-otp.service.ts:115-125`) |

---

# 7. Input validation (audit question #7) — the make-or-break check

**There is NO global `ValidationPipe`.** `apps/api/src/main.ts` (whole file, 101 lines) registers `useGlobalFilters` (`:91`), `enableCors` (`:94`), `enableShutdownHooks` (`:95`), and a path-scoped raw-body middleware (`:78`) — and nothing else. Grep for `useGlobalPipes` / `APP_PIPE` across `apps/` returns zero hits. This is **not** the class-validator footgun the question anticipates: the codebase does not use class-validator at all. Validation is per-parameter Zod via `ZodValidationPipe` (`apps/api/src/common/pipes/zod-validation.pipe.ts:11-27`), which `safeParse`s and throws a 400 with field paths only.

I enumerated every `@Body` / `@Query` / `@Param` on the payer + agency surface. **Coverage is complete**: the only unpiped params are `@Param("id", new ParseUUIDPipe())` on `payer-job-postings.controller.ts` (8×), `payer-org-members.controller.ts:62`, and `payer-unlocks.controller.ts:85` — all validated by `ParseUUIDPipe`. Every `@Body` and `@Query` on the payer surface carries a `ZodValidationPipe`.

**The residual risk is structural, not present**: because validation is opt-in per parameter, a new route that forgets the pipe silently accepts arbitrary input, and no test or lint rule catches it.

---

# 8. Rate limiting (audit question #8)

| Surface | Capped? | Knob / default |
|---|---|---|
| `POST /payer/signup`, `/login/request`, `/login/verify` | per-IP hourly | `PAYER_AUTH_MAX_PER_IP_PER_HOUR` = 20 (`server.ts:437`), `payer-auth.controller.ts:95-101` |
| `POST /payer/unlocks`, `/unlocks/:id/reveal` | per-payer hourly | `PAYER_DISCLOSURE_MAX_PER_HOUR` = 30 (`server.ts:434`), `payer-unlocks.controller.ts:68,89` |
| `POST /payer/resume-disclosures` | per-payer hourly | same bucket, `payer-disclosure.controller.ts:59` |
| `GET /payer/reach/jobs/:jobId/applicants` | per-payer hourly | `PAYER_REACH_MAX_PER_HOUR` = 60 (`server.ts:456`), `payer-reach.controller.ts:69-72` |
| `GET /payer/agency/workers` | per-payer hourly | same bucket, `agency-workers.controller.ts:43-46` |
| `POST /payer/agency/invites`, `/invites/batch` | per-payer hourly, batch charges N units atomically | `AGENCY_INVITE_MINT_MAX_PER_HOUR` = 60 (`server.ts:463`), `agency-invites.controller.ts:56,101` |
| **`POST /payer/credits`** | **NO** | — |
| **`POST /payer/credits/order`** | **NO** | — |
| **`POST /payer/credits/verify`** | **NO** | — |
| **`POST /payer/capacity`** | **NO** | — |
| **`POST /payer/job-postings/:id/{plan,boost,quota-topup}`** | **NO** | — |
| **`POST /payer/job-postings`** (create) | **NO** | — |
| **`POST /payer/job-posting-chat/{session,message}`** | **NO** | Each `message` is a paid LLM call (`job-posting-chat.service.ts:202`) |
| `POST /payer/org/members` | no rate cap, but a seat cap | `MEMBER_INVITE_MAX_PER_ORG` = 25 (`server.ts:560`) |
| `POST /payer/agency/{kyc,payouts}` | **NO** | flag-gated OFF |

The limiter itself is correct: `PayerDisclosureRateLimit` (`payer-disclosure-rate-limit.service.ts:79-120`) is atomic (`INCR`/`INCRBY`), re-asserts TTL every hit, fails CLOSED on Redis error, and returns a byte-identical 429 for cap-reached and Redis-down (`:17`).

---

# 9. PII on the payer/agency surface (audit question #9)

**No raw worker PII leaves the boundary outside the paid unlock path — and not even there.**

- `POST /payer/unlocks/:id/reveal` returns `{ relay_handle, channel, expires_at }` only (`unlocks/unlock-response.ts:52-57`). There is deliberately no phone/name field on the type, so a leak is a compile error.
- The single decrypt: `unlocks.service.ts:873-887` — `wireInAppRelay` decrypts the phone into a narrow local, does nothing reversible with it (`:882 void phone.length`), and returns `relay_${unlockId}_${randomUUID()}` — not derived from the phone.
- **CI-enforced:** `unlocks/unlocks-static-guards.test.ts:55-67` asserts exactly ONE `.decrypt(` site under `unlocks/`; `:41-53` asserts `UnlocksRepository` is imported only from within `unlocks/`. I verified the guard is real by grepping `\.decrypt\(` repo-wide: 19 sites, exactly one of which is on the unlock path.
- Masked resume: `disclosures/resume-disclosure.service.ts:216` — `maskInitials(decrypt(fullName))`, a single decrypt at render.
- Agency surface: `agency-workers.service.ts:60-104` returns a per-agency HMAC pseudonym, `profileComplete`, counts, and a coarse UTC day. Three independent protections documented at `:27-44` (consent in the SQL, tenancy, pseudonymity). The within-day ordering is deliberately re-derived from the pseudonym (`:79-101`) so it carries no uuid signal.
- Agency KYC read: last-4 only (`agency-kyc.service.ts:71-72`).
- Org member list: emails decrypted then masked (`payer-org-members.service.ts:241`).
- Frontend: `apps/payer-web/src/lib/unlock-view.ts:28-36` — `ContactView` has no phone field by construction; `:39-49` and `:72-91` collapse every deny cause to one neutral view. `masking.ts` can only produce ≤2 initials, an id fragment, `••••last4`, or a band join.
- Defence-in-depth: `assert-no-agency-pii.ts:25-70` scans agency payloads for forbidden keys. **Caveat:** it THROWS only in dev/test and merely strips + `console.warn`s in production (`:129-139`) — a prod regression degrades silently.

**One own-session exception, already ruled:** `GET /payer/me` returns the payer's own email and masked phone (`payer-account.controller.ts:23-32`, `payers.repository.ts:204-206`), with `Cache-Control: no-store` (`:29,43`). That is the payer's own data, not worker PII.

---

# 10. Secrets, headers, CORS (audit question #10)

| Control | Status | Evidence |
|---|---|---|
| CORS | Correct, fails closed | `main.ts:94` → `resolveCorsOrigins` (`packages/config/src/server.ts:878-887`): reflect-all in dev only; outside dev an explicit allow-list; **empty list ⇒ `false` ⇒ deny all**. Never `*` |
| helmet / security headers | **ABSENT on both apps** | No `helmet` dependency or import anywhere in `apps/`; `main.ts` registers no header middleware; `apps/payer-web/next.config.mjs` (11 lines) has no `headers()`. So: no CSP, no HSTS, no `X-Frame-Options`, no `X-Content-Type-Options`, no `Referrer-Policy`, no `Permissions-Policy` |
| Secret in `NEXT_PUBLIC_*` | None | Grep of `NEXT_PUBLIC` in `apps/payer-web/src`: only `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_ENVIRONMENT`, `NEXT_PUBLIC_PAYER_THEME`, and six `NEXT_PUBLIC_ENABLE_AGENCY_*` booleans (`config.ts:86-95`) |
| Secret in a client component | None | The `rzp_*` key ID reaches the browser on the order RESPONSE, never as a build constant (`server-config.ts:18-20`, `credits/razorpay-checkout.ts:9`). `INTERNAL_SERVICE_TOKEN` was removed from payer-web (`server-config.ts:22-25`) |
| API base URL | Server-only | `payerServerConfig().apiBaseUrl` from `PAYER_API_URL` (`server-config.ts:63`), module is `import "server-only"` |
| Error-body leakage | Minor | `all-exceptions.filter.ts:29-45` echoes the full `HttpException` response body and `req.url` (query string included); stack traces are logged, never returned (`:40-42`) |
| Boot-time fail-closed | Strong | `main.ts:31-38` — eight `assert*Config` calls that crash the process on dev secrets, half-configured providers, or a dev admin JWT |

---

# 11. RLS posture (audit question #11)

Measured against `packages/db/migrations/*.sql`:

- **`CREATE POLICY` count: 0.**
- `ENABLE ROW LEVEL SECURITY`: 67 statements across **64 distinct tables** (including every payer table: `payers`, `payer_orgs`, `payer_members`, `payer_credits`, `payer_capacity`, `payer_form_drafts`, `payer_job_posting_chat_sessions`/`_messages`, `credit_ledger`, `unlocks`, `unlock_routing`, `payment_orders`, `posting_plans`, `posting_boosts`, `job_postings`, `jobs`, `job_reach`, `resume_disclosures`, `agency_invites`, `agency_kyc`, `agency_payout_accruals`, `agency_payout_requests`).
- `FORCE ROW LEVEL SECURITY`: 68 statements.
- `REVOKE ALL` from `anon`/`authenticated`/`service_role`: present from migration `0004_workers_force_rls_revoke.sql` onward.
- The API connects as a **BYPASSRLS** role: `apps/api/src/database/database.module.ts:15-20` — "DATABASE_URL MUST point at a BYPASSRLS role, or workers reads/writes will be denied (42501)".

**Plain statement of the risk posture.** RLS here is a **Supabase Data-API lockout, not per-tenant row filtering.** ENABLE+FORCE with zero policies means deny-by-default for every non-BYPASSRLS role; the REVOKEs mean PostgREST roles cannot reach the tables even before policy evaluation. The application role bypasses all of it. Therefore:

- **A leaked `anon` or `service_role` (Supabase Data API) key exposes NOTHING** on these 64 tables — this is the threat the design actually closes, and it closes it well.
- **A leaked `DATABASE_URL` (the BYPASSRLS `postgres.<ref>` role) exposes EVERYTHING** — every tenant's rows, every encrypted PII column, on every table. There is no second line of defence at the database.
- **Tenant isolation is 100% application-layer.** A single missing `payer_id` predicate in one repository method is a full cross-tenant read with nothing beneath it to catch it. That is the exact reason PAY-SEC-05 (one chokepoint, ten hand-rolled implementations) is rated P1 rather than cosmetic, and why the org-tenancy rewrite (~30 predicate sites) is the single highest-risk change on this surface.
- `payer-scope.ts:6-9` is candid about this: "This is the **app-layer** control that ships first … **DB-enforced RLS is the open-GA launch gate** (Q5 / ADR-0004)". That gate is not met.

---

# 12. Test coverage of this dimension

| Asset | Reality |
|---|---|
| `apps/api/src/common/guard-contract.test.ts` | Self-described "single source of truth for which guards protect every route" (`:52-62`). Imports 45 controllers of 62. **Missing: `PayerJobPostingsController`, `PayerAccountController`, `PayerDisclosureController`, `PayerOrgMembersController`, `PayerOrgInvitesController`, `JobPostingChatController`** — verified by grep, zero hits for any of those names in the file. The `/payer/job-postings/:id/{plan,boost,quota-topup}` money routes and the only `@OrgRoles` routes in the system are outside the net |
| Guard ORDER assertions | Only for the worker consent chain (`:484-529`). No assertion that `PayerOrgRoleGuard` runs after `PayerAuthGuard` |
| `apps/api/src/agency/agency-role-authz.test.ts` | Good: binds real controller metadata to a real `PayerRoleGuard`; employer→403, agent→pass, `role:null`→403. Covers AgencyJobs, AgencyInvites, AgencyPayouts — **not AgencyWorkers** |
| `apps/api/src/unlocks/unlocks-static-guards.test.ts` | Real CI gate on the one-decrypt and sole-writer invariants |
| `tests/e2e/payer-tenancy.e2e.test.ts:93` | **`describe.skip`** — the only HTTP-level cross-payer authz test in the repo |
| `tests/e2e/payer-capacity.e2e.test.ts:106` | **`describe.skip`** |
| `apps/payer-web` | 83 SSR/unit tests; the org gate is asserted only against a MOCKED `requireOwner` (`credits/actions.test.ts:38-40`), so it proves call-order, not that a real Owner can ever pass. No Playwright/Cypress anywhere in the repo |

---

# 13. Findings index

| ID | Sev | Title |
|---|---|---|
| PAY-SEC-01 | P0 | 11 SPEND routes have no server-side Owner gate |
| PAY-SEC-02 | P0 | `getOrgRole()` stub hard-denies → the only Owner gate in the system has never run, and /credits + /team are 404 in prod |
| PAY-SEC-03 | P0 | Member removal neither revokes sessions nor is checked per request |
| PAY-SEC-04 | P1 | `resolveOrgForPayer`'s single-membership assumption is already violated by every invited teammate |
| PAY-SEC-05 | P1 | The tenant chokepoint has one consumer; ten repositories hand-roll ~30 predicates |
| PAY-SEC-06 | P1 | The authz contract test omits 6 payer/agency controllers incl. the money surface |
| PAY-SEC-07 | P1 | No rate limit on any payer money route or on the AI-spend chat route |
| PAY-SEC-08 | P1 | No security headers on either app |
| PAY-SEC-09 | P1 | The only HTTP-level cross-tenant test is `describe.skip` |
| PAY-SEC-10 | P1 | No global ValidationPipe — validation is opt-in per parameter |
| PAY-SEC-11 | P2 | Rolling session refresh is dead in the portal; the JWT is never rotated |
| PAY-SEC-12 | P2 | `Secure` cookie flag is a fail-open heuristic |
| PAY-SEC-13 | P2 | Buy-plan/boost ownership is a controller-level pre-read, not a service invariant |
| PAY-SEC-14 | P2 | `PayerOrgRoleGuard` swallows resolve errors with no diagnostic |
| PAY-SEC-15 | P2 | MATCH_V1 reach path checks ownership against a different table than the legacy path |
| PAY-SEC-16 | P2 | Payer role is self-elected at signup |
| PAY-SEC-17 | P2 | `assertPayerOwns` throws a descriptive 403, contradicting its own no-oracle docblock |
| PAY-SEC-18 | P2 | Agency PII scrub throws in dev/test but only warns in production |
| PAY-SEC-19 | P3 | `POST /payer/agency/invites/:code/click` is a cross-tenant funnel write |
| PAY-SEC-20 | P3 | `requireEmployer` is defined but never called |
| PAY-SEC-21 | P3 | `AllExceptionsFilter` echoes the request URL and full exception body |
