# Payer Org Tenancy — Phased Plan (PAY-DB-01)

**Decision of record:** [ADR-0053](../decisions/0053-payer-org-tenancy-anchor-key.md). This file is
the build plan for that ADR: phases, file-level scope, every predicate to rewrite, tests, rollback,
census SQL, and which owner decisions block which phase.

**Owner rulings 2026-10-08 (ADR-0053 §11; PR #2136):**

- **Accepted:** the tenancy key, O-1 to O-7, O-9, and invite refusals A1–A3.
- **Not ruled:** O-8, arming `shadow` and then `on` in production. It stays the owner's call after
  the §5 checklist.
- **Effect:** **P1 and P2a–P2d are now unblocked.** P1 ships A1–A3 together.

**Baseline:** `origin/main` at `c9b1237a` (2026-10-07). Line numbers are against that commit.
Re-derive them at build time; do not trust them blindly.

**Why most phases are safe to merge at any time:** the program has **no migration**. Every PR before
the flip runs with `PAYER_ORG_TENANCY_MODE=off`. In that mode the tenant key equals the
authenticated login (ADR-0053 §5.3), so each Phase 2 PR is a provable no-op until the owner arms the
flag. A merge therefore never depends on the owner hand-applying SQL first.

---

## 1. Phase overview

| Phase | PR | What ships | Mode in prod | Behaviour change | Owner decisions that block it | Gates |
|---|---|---|---|---|---|---|
| **P0** | this PR | ADR-0053, this plan, register updates | — | none | — | Chief Architect |
| **P1** | 1 | resolver + `TenantKey` brand + mode flag + accept invariants A1–A3 + census script + **red tests** | `off` | accept refusals A1–A3 only | none (O-9 ruled 2026-10-08) | code-reviewer · security-reviewer · DevOps (ci.yml, compose, deploy bridge) · QA clean-env |
| **P2a** | 1 | postings + applicants + Candidates inbox predicates, **and agency jobs** (moved from P2d at build time, §3.1) | `off` | none | — | security-reviewer (tenant isolation) · code-reviewer |
| **P2b** | 1 | unlocks, credits, ledger, payment orders, resume disclosures, relay. **Red test goes green once P2a and P2b are both on `main`** | `off` | none | none (O-1, O-3 ruled 2026-10-08) | security-reviewer · code-reviewer (money + event meaning, ADR §7) |
| **P2c** | 1 | plans, boosts, quota top-up, capacity, coupons | `off` | none | none (O-4 ruled 2026-10-08) | security-reviewer · code-reviewer |
| **P2d** | 1 | agency invites, workers, KYC, earnings, payouts (+ owner gates); agency jobs shipped in P2a | `off` | owner-only gate on agency KYC, earnings and payouts (O-5; flag-off surface) | none (O-5 ruled 2026-10-08) | security-reviewer · code-reviewer |
| **P3** | 1 + 2 owner actions | completeness gate (T5 allowlist empty) → census → `shadow` → `on` | `shadow` → `on` | **the fix** | **O-8** (owner's call). O-2 and O-6 ruled 2026-10-08 | security-engineer pass on a seeded team org · owner sign-off |
| **P4** | deferred | `actor_payer_id` columns · `org_id` + DB-enforced RLS · ownership transfer · multi-org | — | — | separate ADRs | migration-reviewer |

**Order:**

- P1 lands first.
- P2a–P2d can merge in any order. Each is a no-op in `off`.
- **The red test flips from `it.fails` to `it` in whichever of P2a or P2b lands second.** That is
  the PR in which "B sees A's postings + credits" first becomes true in `on`.
- P3 is blocked until all of P2 is on `main`, which T5 enforces (§5).

**Collision note:** branch `feat/api-applicant-stages` will most likely take migration `0134`. This
program takes **no** migration number, so the two cannot collide. That branch must follow the ADR
§4 rule: scope through posting ownership, and name any actor column `actor_payer_id`.

---

## 2. Phase 1 — resolver, flag, invariants, census, red tests (file-level)

**Nothing in P1 changes which rows any request sees.** No repository predicate changes.

### 2.1 Config and deploy plumbing (DevOps review)

| File | Change |
|---|---|
| `packages/config/src/server.ts` | `PAYER_ORG_TENANCY_MODE`: `z.enum(["off","shadow","on"]).default("off")`, preprocessed so `""` reads as unset. Compose sets an unset variable to `""`, and a bare enum rejects `""`. |
| `packages/config/src/config.test.ts` | default `off`; `""` → `off`; invalid value fails boot |
| `docker-compose.staging.yml` (API service env) | `PAYER_ORG_TENANCY_MODE: ${PAYER_ORG_TENANCY_MODE:-off}` |
| `.github/workflows/ci.yml` — deploy job | `PAYER_ORG_TENANCY_MODE: ${{ secrets.PAYER_ORG_TENANCY_MODE }}` plus the `envs:` bridge entry. Mind the ssh `script:` size ceiling. |
| `.github/workflows/ci.yml` — `e2e` job | API env `PAYER_ORG_TENANCY_MODE: "on"`. Every e2e suite then exercises the solo-identity property. |
| `.github/workflows/ci.yml` — DB-gate step (~L1564) | add `payer-org-tenancy.db` to **both** file lists; add `payers` to the directory alternation in check (1); bump check (2) from `20 passed (20)` to `21 passed (21)` |
| `apps/api/src/config/deploy-workflow-taxonomy.guard.test.ts` | pin the new secret bridge and the compose default `off`, the same way `AGENCY_TWIN_SYNC_ENABLED` is pinned |

### 2.2 Resolver (Backend Platform owns the internals)

| File | Change |
|---|---|
| `apps/api/src/payers/payer-tenant-scope.ts` **(new)** | `TenantKey` brand; `PayerTenantScope`; pure `chooseActingOrg(memberships, actorId, mode)` implementing ADR §3.2 R2–R6 (R4's heal is in the service) |
| `apps/api/src/payers/payer-tenant-scope.service.ts` **(new)** | `resolve(actorPayerId)`: R1 read, R4 heal via `ensureSoloOrg`, R7 fail-closed, `shadow` logging `{actor, would_key, would_differ, outcome, ms}`. The **only** reader of `PAYER_ORG_TENANCY_MODE`. |
| `apps/api/src/payers/payer-orgs.repository.ts` | new `listActiveMembershipsWithAnchor(payerId)`: `payer_members` ⋈ `payer_orgs` ⋈ the anchor's `payers` (id, role, status). DB access only. **As built (PR #2155):** `resolveOrgForPayer` is **removed**, not delegated — a repository that called `chooseActingOrg` would hold business logic and need the mode. The repository returns raw rows; the choice is the service's `resolveActingOrg` (in `off` it keeps the most-recently-accepted tie-break, NULL first), and login's heal is the service's `ensureActingOrg`. |
| `apps/api/src/payers/payer-org-role.guard.ts` | same choice function (Team page = data scope) |
| `apps/api/src/payers/payer-session-org-claim.ts` | same choice function |
| `apps/api/src/payers/payer-account.service.ts` (`GET`/`PATCH /payer/me`, `:43`, `:86`) | same choice function |
| `apps/api/src/payer-portal/payer-auth.service.ts` (`:307-315`) | same choice function |
| `apps/api/src/payers/payers.module.ts` | provide and export `PayerTenantScopeService` |
| `apps/api/src/payers/payers.module.boot.test.ts` **(new)** | **As built:** a STATIC wiring test, not a boot — this repo's vitest emits no `design:paramtypes`, so a `Test.createTestingModule` boot resolves every dependency as `undefined` and passes regardless. It reads who injects the resolver from source (TypeScript syntax tree) and walks every module reachable from `AppModule` to assert each one that provides or mounts such a class can resolve it. The real boot is the CI `e2e` job (it starts the built API). |

### 2.3 Membership invariants (ADR §3.5)

| File | Change |
|---|---|
| `apps/api/src/payer-portal/payer-org-members.service.ts` (`accept`, `:149`) | before `acceptInvite`: **A1** refuse if the accepter holds an active team membership; **A2** refuse if the accepter anchors an org with any other non-removed member; **A3** (O-9, ruled 2026-10-08) refuse on role mismatch. Neutral 409, logged, no event. |
| `apps/api/src/payer-portal/payer-org-members.service.test.ts` | each refusal; the happy path; a refusal consumes no token |

### 2.4 Census (read-only, production-safe)

| File | Change |
|---|---|
| `packages/db/src/audit-org-tenancy.ts` **(new)** | runs §6 queries C1–C8 (C5b reports the team members' wallet credits on its own line) and prints counts plus ids only. Read-only by construction: no write statement is compiled in, and the whole run is one `sql.begin("read only", …)` transaction checked to report read-only; a role without BYPASSRLS is refused. Exits 1 when the §5 flip gate fails. |
| `packages/db/package.json` | `"db:audit:org-tenancy": "tsx src/audit-org-tenancy.ts"` |

### 2.5 Red tests (must be observed RED in CI)

| File | Change |
|---|---|
| `apps/api/src/payers/payer-org-tenancy.db.test.ts` **(new, `RUN_DB_TESTS`)** | **T0.** Real services and repositories. A signs up; A invites B with a capturing mailer, so the raw token is available in-process; B signs up and accepts; A creates a posting and receives credits (mock pack). With the mode `on`: B lists postings and finds A's posting; B's credits equal A's balance; B unlocks a worker and A's wallet is debited; A sees B's unlock; B is removed, and on the next call B sees none of A's rows. Landed as **`it.fails`**: in P1 the predicates still use the actor, so it fails and `it.fails` passes. Flipped to `it` in the PR that makes it pass. |
| `tests/e2e/payer-tenancy.e2e.test.ts` | **T0-HTTP.** Same story over live HTTP. Two `POST /payer/test-login` sessions; B's membership is seeded through the suite's existing DB client, because the mock mailer never lets the raw accept token leave the API process. `it.fails` until P2a and P2b. |
| `apps/api/src/payers/payer-tenant-scope.test.ts` **(new)** | **T3.** Every R-rule branch, including each fail-closed path. `off` never throws. **T1** is the solo-identity property: across generated membership sets, `on` gives `tenantKey === actor` unless the actor is a non-anchor team member. |
| `apps/api/src/payers/payer-tenancy.static.test.ts` **(new)** | **T5** architecture test (precedent: `payer-job-ref-policy.static.test.ts`). It lists every repository method that touches a §3 table with a raw `payerId: string`. Lands with the current list as an explicit allowlist. P2 PRs shrink it. P3 asserts it is empty, apart from the named exceptions in §4. |
| config single-reader test | asserts `PAYER_ORG_TENANCY_MODE` is read only by `payer-tenant-scope.service.ts` |

**P1 does not touch:**

- any repository predicate
- any API response shape
- any event schema
- any migration
- `apps/payer-web` or `apps/payer-app`

The accept page should explain an A1–A3 refusal; raise that as a Frontend issue (CLAUDE.md §6).

---

## 3. Phase 2 — predicate switch, by domain

**Same pattern in every PR:**

- The service resolves the scope once at its entry point.
- The repository signature changes from `payerId: string` to `tenant: TenantKey` for every
  tenant-row predicate and stamp.
- Actor fields stay on `scope.actorPayerId`: `created_by`, the event envelope `actor`, rate
  limiters, and member-private rows.
- Event payload payer-reference fields follow ADR §7.
- Controllers keep passing `payer.id`. They change only where they currently do more than that.
- Trusted ops routes that take a payer id flow through the **same** service entry point, and so
  through the resolver (ADR §5.2 rule 4).
- **Every PR shrinks the T5 allowlist** and adds T2 isolation cases for its routes.
- **Every PR converts by hand what T5 cannot see** in its domain (§5 item 4 lists them): P2a owns
  `JobPostingsRepository.create`; P2c owns `PostingPlansRepository.lockPayer`, `couponUsage`,
  `insertPlan` and `insertBoost`.
- **No cast to the brand.** `payer-tenancy.static.test.ts` (S-F1) refuses a type assertion to
  `TenantKey` / `PayerTenantScope` / `ActingOrgChoice` outside `payer-tenant-scope.ts`; inputs reach
  services only as Zod-parsed DTOs and the session id (a value typed `any` would slip the brand).
- **Before P3:** close risk register **R65** (the A1/A2 accept race; §5 item 5).

### 3.1 P2a — postings, applicants, Candidates inbox

| File | Methods / predicates |
|---|---|
| `apps/api/src/job-postings/job-postings.repository.ts` | `findByIdAndPayer` `:294` · `listByPayer` `:304` · `updateOwned` `:326` · `closeOwned` `:344` · `transitionOwned` `:370` (`create` `:222` is stamped by the service) |
| `apps/api/src/job-postings/job-postings.service.ts` | `createForPayer` `:362` (`payerId` = tenant key, `createdBy` = actor) · `listForPayer` `:387` · `getOneForPayer` `:392` · `updateForPayer` `:398` · `closeForPayer` `:430` · `pauseForPayer` `:447` · `resumeForPayer` `:467` |
| `apps/api/src/payer-portal/job-posting-chat/job-posting-chat.service.ts` | publish `:608-636`: `createForPayer` takes the scope. Session reads and writes (`claimForPublish`, `bindPublishedPosting`, list, messages) **stay actor-keyed** (O-7). |
| `apps/api/src/payers/owned-job-ref.ts` | `findOwnedJobRef` `:28` (shared with unlocks and disclosures; twin ownership stays the source's, ADR-0050 §4.5) |
| `apps/api/src/payer-portal/payer-applicants.service.ts` | `listForOwned` `:71` · `assertOwnsPosting` `:96` |
| `apps/api/src/reach/reach.repository.ts` · `reach.service.ts` | `findOwnedJobSignalRowById` `:272` · `findOwnedJobSignalRowsByIds` `:290` · `tryApplicantsForOwnedJob` (service `:132`) |
| `apps/api/src/payer-portal/payer-applicant-inbox.repository.ts` · `.service.ts` | `inboxPageStatement` `:65` (raw SQL predicates `:88`, `:106`, `:110`) · `listPage` `:139` · service `list` `:65` |
| `apps/api/src/match/match-feed.repository.ts` | `listRankedCandidatesByApplication` `:411` (`jp.payer_id = …` `:435`). `listFeed`'s `payer_key` (`:203`) needs **no change**: it already keys on the anchor. |
| `apps/api/src/payers/payer-scope.ts` | retype `assertPayerOwns` / `assertOwnedRows` / `readOwnedById` to `(scope.tenantKey, row tenant-key column)` |
| applicant-stage table (if merged) | verify it authorizes only through `getOneForPayer` / `findOwnedJobRef` |

**As built (P2a PR, 2026-10-08).** Line numbers above are the plan's baseline; the shipped shape:

- **Converted (T5 allowlist −16):** `JobPostingsRepository.{findByIdAndPayer, listByPayer,
  updateOwned, closeOwned, transitionOwned}` · `ReachRepository.{findOwnedJobSignalRowById,
  findOwnedJobSignalRowsByIds}` · `inboxPageStatement` (and `PayerApplicantInboxRepository.listPage`)
  · `MatchFeedRepository.listRankedCandidatesByApplication` · `AgencyJobsRepository.{create,
  findOwnedById, listOwned, updateOwned, closeOwnedIfLive, pauseOwnedIfOpen, resumeOwnedIfPaused}`.
- **Hand-converted (T5 cannot see them):** `JobPostingsRepository.create` takes
  `NewTenantJobPosting` (`payerId: TenantKey | null`; NULL = ops/twin), and the create content type
  can no longer carry `payerId`/`createdBy` · `PayerApplicantStagesRepository.findOwnedPostingKind`
  (a delegate, blind spot 8) takes the tenant key · `payer-scope.ts` (`assertPayerOwns`,
  `assertOwnedRows`, `readOwnedById`) takes `TenantKey` · the services' internal seams
  (`ReachService.tryApplicantsForOwnedJob` / `applicantsForOwnedJob` take the scope,
  `appliersForOwnedJobs` and `MatchCandidatesService.rowsForOwnedApplications` the key).
- **NOT converted here — `owned-job-ref.ts findOwnedJobRef` stays on the allowlist.** Its P2b
  callers (`UnlocksRepository.findOwnedJobRef`, `ResumeDisclosureRepository.findOwnedJobRef`) still
  pass a raw id, so retyping the helper would break them; whichever of P2a/P2b lands second
  retypes it. P2a's own caller already passes the tenant key, so the board is org-scoped now.
- **Agency jobs moved here from P2d** (the jobs are the agency's postings; `payer-scope.ts` could
  not be retyped while its only callers, the agency job paths, still held a raw id).
- **Resolution points:** each controller-facing entry point (`*ForPayer`, the agency job methods,
  `PayerApplicantsService.listForOwned`, `PayerApplicantInboxService.list`,
  `PayerApplicantStagesService.setStage`, the chat `publish`) resolves ONCE; composed callers take
  the scope (`JobPostingsService.createInScope` / `getOneInScope`). The chat publish resolves
  before it claims the session, so a refused resolution claims nothing. Controllers are unchanged.
- **Event meaning:** `job_posting.*` — actor = the login, `created_by` = the login, no payer field
  (unchanged schema). `job.*` (agency) — actor = the login, payload `payer_id` = the tenant key, by
  ADR §7's general rule (on a tenant business event the envelope actor is the acting login and
  the payload's payer-reference fields carry the tenant key); `job.*` is now on §7's list. It is
  also what `opsSetMatchSkills` already reported (the job's owning agency). `feed.shown` and
  `payer.applicant_stage_changed` — actor = the login; the stage row's `actor_payer_id` = the
  login.
- **O-10 (owner ruling 2026-10-08) — the posting carries the org's name.** A teammate's
  chat-published posting is stamped with the FOUNDER's company name (`org_label` from the tenant
  key's `payers.org_name_enc`); the teammate stays `created_by` and the event actor. Shipped here
  for the AI chat publish (`JobPostingChatService.publish` reads the org name AFTER resolving the
  scope; in `off` the tenant is the login, so byte-identical). **Not shipped here — on the P2
  checklist: the manual posting form's prefill.** payer-web (`sessionOrgLabel`) and payer-app
  stamp `org_label` client-side from `GET /payer/me` `orgName`, the person's own account field
  (plan §4: the person, not the tenant). Proposed: an additive `GET /payer/me` field carrying
  the tenant's org name (equal to `orgName` in `off`), then a Frontend issue to prefill from it.
  The server never overrides a client-sent `org_label` (that would change `off`).
- **Hazard for P2b/P2c (N+1):** `PayerJobPostingsController.enrich` calls `getPostingStats` and
  `countDisclosuresForPosting` once PER POSTING with the raw session id. If those resolve inside,
  `GET /payer/job-postings` resolves N+1 times (ADR §5.4 budget); give them a scope-taking seam.
- **Hazard for P2c (split purchase, review of PR #2167):** the plan, boost and quota-top-up
  routes (`POST /payer/job-postings/:id/plan` · `/boost` · `/quota-topup`) check ownership
  through `getOneForPayer` — the ORG after P2a — but then purchase through
  `PostingPlansService.*ForPayer(id, payer.id, …)` under the LOGIN until P2c. In `on` a
  teammate would pass the org's ownership check and buy under their own login and wallet. P2c
  must give these three routes ONE scope-taking seam (resolve once, check ownership and purchase
  with the same scope). The deploy preflight refuses `on` until P3 (risk R66), so this cannot
  be reached in production.

### 3.2 P2b — money: unlocks, credits, ledger, payment orders, disclosures, relay

| File | Methods / predicates |
|---|---|
| `apps/api/src/unlocks/unlocks.repository.ts` | `findOwnedJobRef` `:175` · `findByPayerWorker` `:180` · `upsertGrant` `:234` (conflict target `:261`, unchanged columns) · `recordDeny` `:285` (`:307`) · `findCreditsForUpdate` `:435` · `getBalance` `:446` · `listCreditLedgerByPayer` `:464` · `tryDebit` `:488` · `appendLedger` `:498` · `creditPack` `:527` · `creditPackWithinTx` `:559` · `createPaymentOrder` `:607` · `listByPayer` `:721` · `listByPayerWithStatus` `:737`. `countDistinctPayersSince` `:214` keeps its SQL; its meaning becomes distinct orgs (**O-3**). |
| `apps/api/src/unlocks/unlocks.service.ts` | `requestUnlock` `:167-369` · reveal owner check `:407` · `listByPayer` `:570` · status list `:581` · `getCredits` `:592` (response `payer_id` stays the caller) · ledger `:613` · `purchasePackMock` `:623` · `createOrder` `:677` · verify `:717` · `resolveRelayForPayer` `:968` (check `:976`) · `resolveJobContext` `:1046-1082` · emitters `:1159-1400` per ADR §7 |
| `apps/api/src/unlocks/payment-gateway.ts` | `settleOrder` `expectedPayerId` `:275` compares with the tenant key; settlement never re-resolves (stamped at intent) |
| `apps/api/src/relay/relay.service.ts` | `:68-75` · `:187-190` pass the scope to `resolveRelayForPayer` |
| `apps/api/src/disclosures/resume-disclosure.repository.ts` | `findOwnedJobRef` `:119` · `findByPayerWorkerPosting` `:124` · `insertRow` `:196` · `countDisclosedForPosting` `:296` · `listByPayer` `:311`. `countDistinctPayersSince` `:173` keeps its SQL (**O-3**). |
| `apps/api/src/disclosures/resume-disclosure.service.ts` | request path `:564`, `:670` · `countDisclosuresForPosting` `:256` |
| `apps/api/src/payer-portal/payer-unlocks.controller.ts` · `payer-disclosure.controller.ts` · `relay/payer-relay.controller.ts` | verify only |
| `apps/api/src/unlocks/unlocks.controller.ts` · `disclosures/resume-disclosure.controller.ts` (ops) | body or path `payer_id` reaches the resolver through the service (rule 4) |
| **Unchanged:** `apps/api/src/match/free-tier.service.ts` `grantForPayer` `:38` | per-account signup grant, actor-keyed by design (ADR §6) |

**T6 (money):**

- Two members debit concurrently and the wallet never overdraws.
- After mixed-member activity, `balance = Σ ledger.delta` per `payer_id`.
- An order created by B settles into A's wallet through both verify and webhook.
- An order created before the flip settles into its original wallet.
- B's unlock of a worker that A already unlocked returns the existing grant and charges no credit.

### 3.3 P2c — plans, boosts, quota top-up, capacity, coupons

| File | Methods / predicates |
|---|---|
| `apps/api/src/posting-plans/posting-plans.repository.ts` | `lockPayer` `:50` (advisory lock per tenant) · `countActivePlansForPayer` `:59` · `getCapacity` `:80` · `upsertCapacity` `:97` · `listPausedPlansForPayer` `:129` · `insertPlan` `:164` / `insertBoost` `:172` stamps · `findActivePlanForPostingAndPayer` `:232` · `addQuotaTopup` `:261` · `couponUsage` `:290` (**O-4**) |
| `apps/api/src/posting-plans/posting-plans.service.ts` | `getPostingStats` `:161` · plan purchase `:186-241` · boost · quota top-up · `buyCapacity` `:440` · `getCapacity` `:510` · emitters (`payment.*`, `coupon.redeemed`, `capacity.purchased`, `posting_plan.*`) per ADR §7 |
| `apps/api/src/payer-portal/payer-capacity.controller.ts` · `payer-job-postings.controller.ts` (`:205`, `:234`, `:273`) | verify only |
| `apps/api/src/posting-plans/posting-plans.controller.ts` (ops `POST /job-postings/:id/plan` and `/boost`, body `payer_id`) | resolves through the service (rule 4) |

### 3.4 P2d — agency

**Agency JOBS shipped in P2a** (`agency-jobs.repository.ts` and the `AgencyService` job methods,
emitters and `readOwnedById` — §3.1 as built). P2d keeps the rest:

| File | Methods / predicates |
|---|---|
| `apps/api/src/agency/agency.service.ts` | `createInvite` `:575` · `referralsSummary` `:924` · invite emitters |
| `apps/api/src/agency/agency-invites.repository.ts` | `create` `:38` (`inviter_payer_id` = tenant key) · `stageCountsForOwner` `:101` |
| `apps/api/src/agency/agency-workers.repository.ts` | `listReferredWithConsent` `:47` (raw SQL `:102`) |
| `apps/api/src/agency/agency-kyc.repository.ts` · `agency-kyc.service.ts` | `upsertPending` `:34` · `findByPayer` `:67` · `submit` `:75` · `getOwnView` `:108` · `statusForGate` `:113` (**O-5**) |
| `apps/api/src/agency/agency-payout.repository.ts` · `agency-payout.service.ts` | `findQualifyingUnlocks` `:69` · `insertAccruals` `:106` · `aggregate` `:127` · `listRequests` `:166` · `createRequestClaiming` `:187` · service `:75`, `:120`, `:156`, `:242` (**O-5**) |
| `apps/api/src/agency/agency-payouts.controller.ts` | per O-5: add `PayerOrgRoleGuard` + `@OrgRoles("owner")` to KYC, earnings and payouts; update `apps/api/src/common/guard-contract.test.ts` |
| `apps/api/src/referrals/referral-link.service.ts` `mintLink` | no caller today; document the rule only (`agent_payer_id` = tenant key when wired) |
| `apps/api/src/agency/agency-kyc-ops.controller.ts` (ops, `:payerId`) | literal: ops verify the anchor's KYC |

---

## 4. Explicit exceptions (stay actor- or literal-keyed; T5 allowlist entries that survive P3)

| Path | Why |
|---|---|
| `apps/api/src/payer-portal/job-posting-chat/job-posting-chat.repository.ts` (every method) | member-private drafts (O-7) |
| `payer_form_drafts` (no consumer) | member-private |
| `apps/api/src/match/free-tier.service.ts` | per-account signup grant |
| `apps/api/src/admin/admin-actions.repository.ts` (`suspendPayerInventory` `:159`, `reinstatePayerInventory` `:203`, `grantCredits` `:244`) · `admin-entities.repository.ts` · `admin-finance.repository.ts` | ops address an account literally. Suspending an anchor already cascades the org's inventory because rows carry the anchor; R5 blocks the org (O-6). |
| `apps/api/src/payers/payer-disclosure-rate-limit.service.ts` and other rate limiters | abuse controls are per principal |
| `apps/api/src/payers/payers.repository.ts` · `payer-account.service.ts` | the person, not the tenant |

---

## 5. Phase 3 — the flip

**Code PR (P3):**

1. T5 asserts the allowlist equals §4 exactly. Nothing else may take a raw payer id for a tenant row.
2. T0 and T0-HTTP are `it` (not `it.fails`) and green on `main`.
3. `docs/payer-agent/*` registers are updated. `GAP-FE-01` and `GAP-AUTHZ-01` are re-checked.
4. **T5's blind spots are HAND-CHECKED, each with its finding recorded in the P3 PR.** An empty
   UNCONVERTED list is not proof of completeness while any of these exist (the same list heads
   `payer-tenancy.static.test.ts`):
   1. `PostingPlansRepository.lockPayer` — an advisory lock keyed by the payer id; touches no table.
   2. `PostingPlansRepository.couponUsage` — counts `coupon.redeemed` in `events` (O-4).
   3. `PostingPlansRepository.insertPlan`, 4. `insertBoost`, 5. `JobPostingsRepository.create` —
      the payer id rides a Drizzle insert type (`New…`) from packages/db, which T5 does not read.
      Same for any parameter typed by a type declared outside apps/api/src. *(5 hand-converted in
      P2a: `NewTenantJobPosting`.)*
   6. A raw id under a name outside T5's pattern (`payerId` / `*PayerId` / `agencyId`) — e.g.
      `ownerId`, `tenantId`, a bare `id`.
   7. A parameter typed `any` / `unknown` carrying a payer id.
   8. A callable that only delegates to a listed helper (safe once the helper is retyped).
   Closed by the PR #2155 scanner, with fixture tests: arrow-function class properties, top-level
   const arrows, Drizzle relational `this.db.query.<table>`, and parameter types declared in
   another apps/api file.
5. **Risk register R65 is closed:** the A1/A2 reads and the accept write run in one transaction
   that first locks the accepter (`SELECT … FROM payers WHERE id = $1 FOR UPDATE` or an advisory
   lock); the invite path takes the same lock on the inviter. Until then census C2 = C3 = 0 is
   the only evidence, and the race fails closed (R3).
6. **Census DB case (P3 prerequisite, review L4):** a `RUN_DB_TESTS` test that seeds C2/C3/C4/C6
   breaches and asserts `runCensus` reports them, wired into the CI DB-gate step. P1 verified this
   by hand on a throwaway database only (PR #2155).
7. **Brand forge guard covers predicates (review N1 of PR #2155):** the static test also refuses a
   type predicate (`x is TenantKey`) or an assertion function (`asserts x is TenantKey`) naming a
   forgeable type outside `payer-tenant-scope.ts`; Phase 2 review checks for inferred generic
   launderers (`launder<T>(x: unknown): T`), which no static test sees.
8. **The owner confirms the R5 / O-6 amendment** (ADR-0053 R5, amended 2026-10-08 in PR #2155:
   the anchor-status check applies only when the actor is not the anchor).
9. **The P3 PR lifts the preflight refusal.** Until P3, `scripts/deploy/staging-deploy.sh`
   refuses `PAYER_ORG_TENANCY_MODE=on` (risk R66; `payer-org-tenancy-mode.guard.test.ts` pins
   it). The P3 PR removes that arm and its test case in the same change that makes T5 assert
   UNCONVERTED is empty.
10. **O-10's manual-form prefill has shipped** (§3.1 as built): the posting form stamps the
    org's name, not the member's own.

**Owner actions (O-8), in order:**

| Step | Action | Pass condition |
|---|---|---|
| 1 | Run `pnpm --filter @badabhai/db db:audit:org-tenancy` against production (read-only) | C2 = C3 = C4 = C6 = 0. C1, C5 and C5b recorded. A non-zero C5 / C5b is expected and needs no further ruling: O-2 (ruled 2026-10-08) keeps those rows and balances personal. Tell the affected members before `on`. |
| 2 | Set the `production` secret `PAYER_ORG_TENANCY_MODE=shadow` and redeploy | — |
| 3 | Observe `shadow` for at least 48 h of payer traffic | zero resolver errors; `would_differ` only for C1 actors; resolver p95 ≤ 5 ms; tenant-route p95 regression ≤ 5 ms (ADR §5.4) |
| 4 | security-engineer pass in a non-production environment with mode `on` and a seeded team org | no Critical or High findings |
| 5 | Set `PAYER_ORG_TENANCY_MODE=on` and redeploy | T0-HTTP passes against production with synthetic `@e2e.badabhai.invalid` payers, if the test-login seam is armed there. Otherwise a manual A-invites-B check. |

**Frontend after `on` (raise as issues; no correctness dependency, because API shapes are
unchanged):**

- payer-web and payer-app: the accept-refusal copy.
- Optional: "posted by" from `created_by`.
- admin-web: show a member's anchor.

---

## 6. Census SQL (read-only; production-safe)

P1 codifies these queries as `db:audit:org-tenancy`. They are listed here so the owner can run them
today. They contain no write.

```sql
-- C1  Team members: the ONLY payers whose view changes at the flip.
SELECT pm.member_payer_id, pm.org_id, po.root_payer_id AS anchor, pm.org_role, pm.accepted_at
FROM payer_members pm
JOIN payer_orgs po ON po.id = pm.org_id
WHERE pm.status = 'active'
  AND pm.member_payer_id IS NOT NULL
  AND po.root_payer_id <> pm.member_payer_id;

-- C2  Invariant A1 breached: more than one active team membership. MUST be 0 before the flip.
SELECT pm.member_payer_id, count(*) AS team_memberships
FROM payer_members pm
JOIN payer_orgs po ON po.id = pm.org_id
WHERE pm.status = 'active'
  AND pm.member_payer_id IS NOT NULL
  AND po.root_payer_id <> pm.member_payer_id
GROUP BY pm.member_payer_id
HAVING count(*) > 1;

-- C3  Invariant A2 breached: the anchor of a team org is an active member of another org. MUST be 0.
WITH team_anchors AS (
  SELECT DISTINCT po.root_payer_id AS id
  FROM payer_orgs po
  JOIN payer_members pm ON pm.org_id = po.id
  WHERE pm.status <> 'removed'
    AND pm.member_payer_id IS DISTINCT FROM po.root_payer_id
)
SELECT pm.member_payer_id, pm.org_id
FROM payer_members pm
JOIN payer_orgs po ON po.id = pm.org_id
WHERE pm.status = 'active'
  AND po.root_payer_id <> pm.member_payer_id
  AND pm.member_payer_id IN (SELECT id FROM team_anchors);

-- C4  Invariant A3 / R6: member role differs from the anchor's role. MUST be 0 (O-9 ruled 2026-10-08).
SELECT pm.member_payer_id, m.role AS member_role, r.role AS anchor_role
FROM payer_members pm
JOIN payer_orgs po ON po.id = pm.org_id
JOIN payers m ON m.id = pm.member_payer_id
JOIN payers r ON r.id = po.root_payer_id
WHERE pm.status = 'active'
  AND po.root_payer_id <> pm.member_payer_id
  AND m.role IS DISTINCT FROM r.role;

-- C5  Born-where (O-2): what each team member owns under their OWN key, which they stop seeing at the flip.
WITH team_members AS (
  SELECT DISTINCT pm.member_payer_id AS id
  FROM payer_members pm
  JOIN payer_orgs po ON po.id = pm.org_id
  WHERE pm.status = 'active'
    AND pm.member_payer_id IS NOT NULL
    AND po.root_payer_id <> pm.member_payer_id
)
SELECT 'job_postings' AS t, count(*) AS n FROM job_postings WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'jobs', count(*) FROM jobs WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'unlocks', count(*) FROM unlocks WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'resume_disclosures', count(*) FROM resume_disclosures WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'posting_plans', count(*) FROM posting_plans WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'posting_boosts', count(*) FROM posting_boosts WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'payer_capacity', count(*) FROM payer_capacity WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'payment_orders', count(*) FROM payment_orders WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'credit_ledger', count(*) FROM credit_ledger WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'payer_credits', count(*) FROM payer_credits WHERE payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'agency_invites', count(*) FROM agency_invites WHERE inviter_payer_id IN (SELECT id FROM team_members)
UNION ALL SELECT 'referral_links', count(*) FROM referral_links WHERE agent_payer_id IN (SELECT id FROM team_members);

-- C5b The same, in CREDITS: the balance in team members' own wallets. Reported on its own line,
--     never summed into C5's row count (PR #2155 review L4). Same team_members CTE as C5.
SELECT coalesce(sum(balance), 0) AS credits FROM payer_credits WHERE payer_id IN (SELECT id FROM team_members);

-- C6  Payers with no solo org, or whose solo org lacks their active owner membership (R4 heals these; MUST be 0 to flip cleanly).
SELECT p.id FROM payers p LEFT JOIN payer_orgs po ON po.root_payer_id = p.id WHERE po.id IS NULL;
SELECT po.root_payer_id
FROM payer_orgs po
LEFT JOIN payer_members pm
  ON pm.org_id = po.id AND pm.member_payer_id = po.root_payer_id AND pm.status = 'active'
WHERE pm.id IS NULL;

-- C7  Team orgs that R5 would block at the flip (org not active, or anchor not active).
SELECT DISTINCT po.id AS org_id, po.status AS org_status, r.status AS anchor_status
FROM payer_orgs po
JOIN payers r ON r.id = po.root_payer_id
JOIN payer_members pm ON pm.org_id = po.id AND pm.status = 'active' AND pm.member_payer_id <> po.root_payer_id
WHERE po.status <> 'active' OR r.status <> 'active';

-- C8  Informational: tenant rows whose key names no payers row (legacy opaque ids; unreachable today and after).
SELECT 'unlocks' AS t, count(*) FROM unlocks u WHERE NOT EXISTS (SELECT 1 FROM payers p WHERE p.id = u.payer_id)
UNION ALL SELECT 'payer_credits', count(*) FROM payer_credits c WHERE NOT EXISTS (SELECT 1 FROM payers p WHERE p.id = c.payer_id)
UNION ALL SELECT 'job_postings', count(*) FROM job_postings j WHERE j.payer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payers p WHERE p.id = j.payer_id);
```

---

## 7. Test strategy

| ID | Test | Where | Phase |
|---|---|---|---|
| **T0** | "A invites B; B sees A's postings + credits" (+ unlock, wallet debit, removal), service level | `apps/api/src/payers/payer-org-tenancy.db.test.ts` (CI DB-gate step) | **red in P1** (`it.fails`) → green in P2a+P2b |
| **T0-HTTP** | the same story over live HTTP and guards | `tests/e2e/payer-tenancy.e2e.test.ts` (CI `e2e` job, mode `on`) | red in P1 → green in P2a+P2b |
| **T1** | solo identity: `on` = `off` for every non-team payer | resolver unit (property); whole e2e suite under `on` | P1, and every P2 |
| **T2** | horizontal isolation: org X cannot list, read, act on or reveal org Y rows (no-oracle); a removed member loses access on the next request; a recruiter is refused team management | per-route tests in each P2 PR (extend `payer-tenancy.e2e.test.ts` and controller tests) | P2a–P2d |
| **T3** | resolver rules R1–R7, each fail-closed path | `payer-tenant-scope.test.ts` | P1 |
| **T4** | accept invariants A1, A2 (A3) | `payer-org-members.service.test.ts` | P1 |
| **T5** | no tenant-table repository method takes a raw payer id (allowlist shrinks to §4) | `payer-tenancy.static.test.ts` | P1 → P3 |
| **T6** | money: concurrent member debits, reconciliation, settle-at-intent, no double charge on an org unlock | P2b DB tests | P2b |
| **T7** | caps and coupons count per tenant (O-3, O-4) | P2b, P2c | P2b, P2c |
| **T8** | `PAYER_ORG_TENANCY_MODE` single reader; deploy bridge pinned | config + `deploy-workflow-taxonomy.guard.test.ts` | P1 |
| **T9** | clean environment: full suite from an empty database (invariant #10) | QA | every phase |

**Mutation bar:** every new guard test must be seen failing before it is trusted.

- **T4:** delete each A-rule and watch its test fail.
- **T3:** invert the R2 preference and watch T1 fail.
- **T5:** add a raw-id method and watch T5 fail.

T0's `it.fails` → `it` flip is itself the proof that T0 can observe the fix.

---

## 8. Rollback per phase

| Phase | Rollback | Data effect |
|---|---|---|
| P1 | revert the PR | none; A1–A3 refusals stop |
| P2a–P2d | revert the PR | none: in `off`, tenant key = actor, so old and new code write identical rows |
| `shadow` | secret back to `off` + redeploy | none (logging only) |
| `on` | secret back to `off` + redeploy | Rows a member wrote in `on` stay under the anchor: the owner keeps seeing them, and the member returns to today's empty view. The wallet and ledger stay reconcilable (same key). No repair needed. Re-flipping later is clean. |
| P4 | per its own ADR | — |

**No phase writes, moves or deletes existing data.** There is no schema rollback, because there is
no schema change.

---

## 9. Owner decisions → phase map (ruled 2026-10-08)

| Decision (ADR §11) | Recommendation | Ruling 2026-10-08 | Was blocking |
|---|---|---|---|
| Tenancy key = `root_payer_id`, no migration, one flag | — | ACCEPTED | P2a onward |
| O-1 org wallet = the anchor's wallet | yes | ACCEPTED | P2b merge |
| O-2 born-where for a member's pre-team data | yes (no merge) | ACCEPTED | flip, only if C5 ≠ 0 |
| O-3 caps count orgs | yes | ACCEPTED | P2b merge |
| O-4 coupon limit per org | yes | ACCEPTED | P2c merge |
| O-5 agency money org-level, owner-only | yes | ACCEPTED | P2d merge; and before `AGENCY_PAYOUTS_ENABLED` |
| O-6 anchor suspension blocks the org | yes | ACCEPTED | flip |
| O-7 chat drafts member-private | yes | ACCEPTED | nothing |
| O-8 arm `shadow` then `on` | after §5 | **Open**: owner's call | P3 |
| O-9 member role must equal the anchor's | yes, for now | ACCEPTED | A3 inside P1 |
| O-10 a teammate's posting carries the founder's org name; the teammate is the creator | — | RULED (owner, 2026-10-08, relayed on PR #2167) | nothing; chat publish in P2a, the manual-form prefill on the P2 checklist (§3.1) |
| Invite refusals A1–A3 | yes | ACCEPTED | P1 |
