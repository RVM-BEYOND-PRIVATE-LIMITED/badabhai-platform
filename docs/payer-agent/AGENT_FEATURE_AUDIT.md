# Agency Feature Audit — endpoint matrix & wiring

**Status:** COMPLETE (audited 2026-08-11, dimension re-run after the usage-limit interruption).
**Method:** evidence-based static analysis; every claim carries a `file:line` citation.
**Findings feed** `GAP_REGISTER.md`. Coverage caveats: `AUDIT_STATUS.md`.

---

# Agency (agent persona) backend endpoint matrix

## Executive summary
The agency surface is 25 routes across five controllers plus the shared referral chain. Counted by status: 12 are LIVE and actually consumed end-to-end (jobs CRUD, invite mint + batch mint, referrals summary, the public click sink, the worker attribution hook); 5 are FLAG-GATED-OFF behind `AgencyPayoutsEnabledGuard` + `AGENCY_PAYOUTS_ENABLED` (the whole KYC/earnings/payout money surface, neutral-404 by default — apps/api/src/agency/agency-payouts-enabled.guard.ts:17-22); 5 are InternalServiceGuard ops routes with no payer-web consumer; 2 are LIVE-BUT-INERT (GET /payer/agency/workers can never return a row, GET /r/:code has no links to resolve); and exactly 1 is DEAD with zero callers anywhere (POST /payer/agency/invites/:code/click). Guard posture is genuinely strong: every payer-facing agency controller carries class-level `@UseGuards(PayerAuthGuard, PayerRoleGuard)` + `@PayerRoles("agent")`, so the PayerRoleGuard no-op footgun does not apply here, and the owning id is always `@CurrentPayer().id` — never a body or param. The faceless boundary on GET /payer/agency/workers is the best-engineered privacy surface in the repo: the consent gate lives inside the SQL join (agency-workers.repository.ts:107-121), the worker uuid is replaced by a per-agency keyed HMAC (agency-workers.service.ts:68), the row order is re-derived from the pseudonym to strip the uuid-derived ordering (agency-workers.service.ts:92-101), and the payload crosses `assertNoAgencyPII` twice — no PII can reach an agency. Three defects matter. (1) apps/payer-web/src/app/(portal)/profile/page.tsx:55-85 renders KYC "Pending" and Bank "Not added / Not set" from hardcoded JSX literals with no call to `getAgencyKyc()` and no payer-api import at all — a fabricated verification status that will keep saying "Pending" after ops verifies a real agency. (2) The referral funnel is arithmetically wrong: `stageCountsForOwner` is a `GROUP BY status` over a single mutually-exclusive status column (agency-invites.repository.ts:101-115), so `created` is "invites still unclicked", yet the UI labels it "Invites created" and computes conversion as `clicked/created` (referrals/page.tsx:128-141, 220-224). (3) `agency_invites.invited_worker_id` carries only a plain index (packages/db/src/schema/referral.ts:164), so one worker can be attributed to two agencies, while `agency_payout_accruals_source_unlock_id_uq` is GLOBAL (referral.ts:288) — meaning whichever agency calls GET /earnings first silently captures the commission. Separately, three doc comments assert facts that are now false (`attributeWorkerToInvite` "has no caller" — it does, referral-attribution.service.ts:102), and `referral-link.service.ts`'s NO-HTTP-CALLER claim is the one that verifies TRUE. The whole `referral_links` / `/r/:code` measurement spine is inert: `mintLink` has no caller outside its own test, so `referral.link_created` / `referral.link_clicked` / `referral.install_claimed` never fire in production.

> **Scope**: the agency (agent persona) backend endpoint matrix — apps/api/src/agency/*, apps/api/src/referrals/*, apps/api/src/messaging/messaging.controller.ts — plus every payer-web consumer.
> **Method**: every controller, service, repository and DB schema block below was opened and read. Doc-comment claims were independently grepped, not trusted. Where a comment contradicts the code, the code is reported.

---

## 1. Route matrix

Legend for **STATUS**:
- `LIVE` — wired end to end, a real consumer calls it, it does what it says
- `LIVE-BUT-INERT` — code path is live but structurally cannot produce a non-empty/meaningful result today
- `LIVE-BUT-WRONG` — live and consumed, but the value it returns is incorrect
- `FLAG-GATED-OFF` — intentionally 404 behind a documented env gate
- `INTERNAL` — InternalServiceGuard, ops-only, no payer-web consumer
- `DEAD` — reachable route with zero callers anywhere in the repo

### 1.1 Agency DEMAND — jobs (`AgencyJobsController`, class guards `PayerAuthGuard, PayerRoleGuard` + `@PayerRoles("agent")`, agency-jobs.controller.ts:31-33)

| # | Route | Controller | Service | Tables | Validation | Response | Pagination | Errors | Events | payer-web consumer | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `POST /payer/agency/jobs` | agency-jobs.controller.ts:38-46 | `AgencyService.createJob` (agency.service.ts:153-199) | `jobs` | `CreateAgencyJobSchema` (agency.dto.ts:130) | `AgencyJobView` 201 | n/a | 400 zod | `job.created` (agency.service.ts:191) | `createAgencyJob` payer-api.ts:578 | agency.service.test.ts, agency.dto.test.ts | LIVE |
| 2 | `GET /payer/agency/jobs` | :49-52 | `listOwnJobs` (:202-211) | `jobs` | none | `AgencyJobView[]` | **NONE — unbounded** | — | none | `listAgencyJobs` payer-api.ts:558 | agency.service.test.ts | LIVE |
| 3 | `GET /payer/agency/jobs/:jobId` | :55-61 | `getOwnJob` (:214-218) | `jobs` | `AgencyJobIdParamSchema` (dto:198) | `AgencyJobView` | n/a | neutral 404 unknown-or-not-owned | none | `getAgencyJob` payer-api.ts:567 | agency.service.test.ts | LIVE |
| 4 | `PATCH /payer/agency/jobs/:jobId` | :64-73 | `updateJob` (:221-326) | `jobs` | `UpdateAgencyJobSchema` (dto:165) | `AgencyJobView` | n/a | 404; 400 closed; 400 no-op; 400 pay/exp ordering | `job.updated` (:323) | `updateAgencyJob` payer-api.ts:588 | agency.service.test.ts | LIVE |
| 5 | `POST /payer/agency/jobs/:jobId/close` | :76-84 | `closeJob` (:329-351) | `jobs` | param | `AgencyJobView` | n/a | 404; 400 already closed | `job.closed` (:348) | `closeAgencyJob` payer-api.ts:621 | agency.service.test.ts | LIVE |
| 6 | `POST /payer/agency/jobs/:jobId/pause` | :91-99 | `pauseJob` (:361-382) | `jobs` | param | `AgencyJobView` | n/a | 404; 400 | `job.updated` `changed_fields:["status"]` (:379) | `pauseAgencyJob` payer-api.ts:606 | agency.service.test.ts | LIVE (degenerate — see AG-19) |

Tenancy: `readOwnedById` / `assertOwnedRows` chokepoint (agency.service.ts:206-209, 754-761). `payer_id` is never read from a body/param.

### 1.2 Agency SUPPLY — invites + funnel (`AgencyInvitesController`, class guards agent-only, agency-invites.controller.ts:34-36)

| # | Route | Controller | Service | Tables | Extra gate | Validation | Response | Errors | Events | payer-web consumer | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 7 | `POST /payer/agency/invites` | :49-65 | `createInvite`→`mintOneInvite` (agency.service.ts:387-485) | `agency_invites` | `PayerDisclosureRateLimit` scope `agency_invite_mint`, cap `AGENCY_INVITE_MINT_MAX_PER_HOUR`=60, **fail-closed** | `CreateAgencyInviteSchema` `.strict()` (dto:308-317) | 201 `{agency_invite_id, code, link:"/i/<code>"}` | 429 (cap **and** Redis-down, indistinguishable); 503 neutral | `agency_invite.created` keyed `:<invite_id>` (:596) | `createAgencyInvite` payer-api.ts:693; `AgencyInvitePanel` | agency.service.test.ts, agency-invites-batch-cap.test.ts | LIVE |
| 8 | `POST /payer/agency/invites/batch` | :94-114 | `createInviteBatch` (:431-466) | `agency_invites` | same bucket, `amount: dto.count`, one atomic reservation | `CreateAgencyInviteBatchSchema` `.strict()`, `count` 1..50 (dto:355-368) | 201 `{invites:[…]}` | 429; 503 when zero minted; **partial subset returned on mid-batch failure** | N × `agency_invite.created` | `createAgencyInviteBatch` payer-api.ts:737; `AgencyBatchInvitePanel` | agency-invites-batch.test.ts, agency-no-per-invite-oracle.test.ts | LIVE |
| 9 | `POST /payer/agency/invites/:code/click` | :124-130 | `recordInviteClick` (:628-651) | `agency_invites` | agent-gated (class guards) | `AgencyInviteCodeParamSchema` — `z.string().min(1).max(64)`, **no hex shape check** (dto:376-377) | `{ok:true}` always | none (neutral on unknown) | `agency_invite.clicked` **unkeyed** | **NONE** | agency.service.test.ts | **DEAD** |
| 10 | `GET /payer/agency/referrals/summary` | :137-140 | `referralsSummary` (:736-745) | `agency_invites` | — | none | `{created, clicked, accepted, minBucket:5}` | — | none | `getAgencyReferralsSummary` payer-api.ts:641; `ReferralFunnel`, referrals/page.tsx | agency.service.test.ts | **LIVE-BUT-WRONG** (AG-04) |

### 1.3 Agency SUPPLY — worker engagement (`AgencyWorkersController`, agent-only, agency-workers.controller.ts:24-26)

| # | Route | Controller | Service | Tables | Extra gate | Response | Pagination | Events | payer-web consumer | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 11 | `GET /payer/agency/workers` | :39-48 | `AgencyWorkersService.listReferred` (agency-workers.service.ts:60-104) | `agency_invites` ⋈ `worker_profiles`, `applications`, `unlocks`, `worker_devices`, `worker_consents` | `PayerDisclosureRateLimit` scope `payer_reach`, cap `PAYER_REACH_MAX_PER_HOUR` | `{workers:[{ref,profileComplete,appliedCount,unlockedCount,lastActiveOn}]}` | hard `LIMIT 200` (`MAX_ROWS`, service:53); **no cursor** | none, by design (service:41-44) | `listAgencyWorkers` payer-api.ts:795; workers/page.tsx:58 | agency-workers.service.test.ts — **no repository test** | **LIVE-BUT-INERT** (AG-05) |

### 1.4 Agency SUPPLY-MONEY (`AgencyPayoutsController`, agent-only **+ `AgencyPayoutsEnabledGuard`**, agency-payouts.controller.ts:20-22)

All five are a **neutral 404** while `AGENCY_PAYOUTS_ENABLED` is off (packages/config/src/server.ts:731, `booleanFromString`, default false).

| # | Route | Controller | Service | Tables | Validation | Response | Errors | Events | payer-web consumer | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 12 | `POST /payer/agency/kyc` | :30-37 | `AgencyKycService.submit` (agency-kyc.service.ts:79-109) | `agency_kyc` | `SubmitAgencyKycSchema` | 201 masked `{status,panLast4,bankLast4,…}` | 409 neutral on cross-agency PAN-hash collision | `agency_kyc.submitted` (payer_id + status only) | `submitAgencyKyc` payer-api.ts; `KycPanel` + `submitKycAction` | agency-kyc.service.test.ts | FLAG-GATED-OFF |
| 13 | `GET /payer/agency/kyc` | :40-43 | `getOwnView` (:112-114) | `agency_kyc` | — | masked view | — | none | `getAgencyKyc` payer-api.ts | agency-kyc.service.test.ts | FLAG-GATED-OFF |
| 14 | `GET /payer/agency/earnings` | :46-49 | `AgencyPayoutService.getEarnings` (agency-payout.service.ts:106-129) | `agency_payout_accruals`, `agency_payout_requests`, `unlocks`, `agency_invites`, `agency_kyc` | — | `AgencyEarningsView` + gate state + `blockedReason` code | — | **`agency_payout.accrued` — a GET that WRITES** (`recomputeAccruals`, :107) | `getAgencyEarnings` payer-api.ts; `EarningsPanel` | agency-payout.service.test.ts | FLAG-GATED-OFF (+ AG-18) |
| 15 | `POST /payer/agency/payouts` | :57-61 | `requestPayout` (:136-177) | `agency_payout_requests` + accruals (tx) | none (no body — amount is server-computed) | `{ok:true,requestId,amountInr,accrualCount}` \| `{ok:false,blocked:true,reason}` **200 either way** | — | `agency_payout.requested` keyed / `agency_payout.blocked` unkeyed | `requestAgencyPayout`; `PayoutPanel` + `requestPayoutAction` | agency-payout.service.test.ts, agency-payouts.controller.test.ts | FLAG-GATED-OFF |
| 16 | `GET /payer/agency/payouts` | :64-74 | `listRequests` (:215-217) | `agency_payout_requests` | — | `{id,amountInr,accrualCount,status,createdAt}[]` | **NONE — unbounded** | — | none | `listAgencyPayouts` payer-api.ts | agency-payouts.controller.test.ts | FLAG-GATED-OFF |

### 1.5 OPS KYC queue (`AgencyKycOpsController`, `InternalServiceGuard`, agency-kyc-ops.controller.ts:21-22)

| # | Route | Controller | Service | Guard | Response | Events | Consumer | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| 17 | `GET /ops/agency-kyc/pending` | :27-29 | `listPendingForOps` (agency-kyc.service.ts:123-126) | InternalServiceGuard **only — NOT behind `AgencyPayoutsEnabledGuard`** | masked last-4 rows | none | apps/web ops console (out of scope) | agency-kyc-ops.controller.test.ts | INTERNAL |
| 18 | `POST /ops/agency-kyc/:payerId/verify` | :33-37 | `verify` (:133-168) | same | `{ok}` | `agency_kyc.verified` keyed `payerId:ts` | ops | agency-kyc.service.test.ts | INTERNAL |
| 19 | `POST /ops/agency-kyc/:payerId/reject` | :40-47 | `reject` (:171-188) | same | `{ok}` | `agency_kyc.rejected` | ops | agency-kyc.service.test.ts | INTERNAL |

`verify` correctly refuses a `suspended` agency (agency-kyc.service.ts:150-153) — the one financial route a suspension can't otherwise reach; `reject` deliberately stays open because it is restrictive.

### 1.6 Referral chain (shared, `apps/api/src/referrals/*` + `messaging.controller.ts`)

| # | Route | Controller | Service | Guard / limit | Tables | Response | Events | Consumer | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|
| 20 | `POST /referrals/attribute` | referral-attribution.controller.ts:39-62 | `ReferralAttributionService.attribute` (:62-116) | `WorkerAuthGuard` + `IpRateLimit("referral_attribute", 20/h)` | `worker_consents`, `invites`, `agency_invites`, `referral_clicks` | constant `{ok:true}` (fire-and-forget, no timing oracle) | `invite.accepted` / `agency_invite.accepted` / `invite.install` / `referral.install_claimed` | worker-app `api_client.dart:891` | referral-attribution.service.test.ts, .controller.test.ts, referral-round-trip.e2e (skipIf) | LIVE |
| 21 | `GET /r/:code` | referral-resolver.controller.ts:43-75 | `ReferralLinkService.resolve` (:149-186) | PUBLIC, `IpRateLimit("invite_click")`, breach **sheds the write, still 302s** | `referral_links` (**always empty**), `referral_clicks` | 302, always | `referral.link_clicked` — **never fires** (:221) | **nothing ships `/r/` links** — invite-landing.ts:76-85 moved everything to `/i/` | referral-link.service.test.ts | **LIVE-BUT-INERT** (AG-10) |
| 22 | `POST /invites/:code/click` | messaging.controller.ts:79-97 | `InviteClickService.recordPublicClick` (:55-71) | **PUBLIC/unauth**, `IpRateLimit("invite_click", REFERRAL_CLICK_MAX_PER_IP_PER_HOUR=600)`, breach → same neutral body | `invites` then `agency_invites` | constant `{ok:true}` | `invite.clicked` / `agency_invite.clicked` (both unkeyed) | **payer-web `invite-landing.ts:153`, server-side, from `/i/[code]`** | invite-click.service.test.ts, messaging.controller.test.ts | LIVE |
| 23 | `POST /invites` | messaging.controller.ts:42-49 | `InviteService.createInvite` | `WorkerAuthGuard` | `invites` | `{invite_id,code,link}` | `invite.created` | worker app | invite.service.test.ts | LIVE (worker funnel, not agency) |
| 24 | `POST /referrals/bonus/evaluate` | referral-bonus.controller.ts:35-41 | `ReferralBonusService.evaluate` | `InternalServiceGuard` | `referral_bonus_accruals` | `BonusOutcome` | — | queue producers: profiles.service.ts:57, unlocks.service.ts:114 | referral-bonus.*.test.ts | INTERNAL |
| 25 | `GET /referrals/bonus/summary` | :44-47 | `totals` | `InternalServiceGuard` | same | counts + ₹ | — | ops | referral-bonus.service.test.ts | INTERNAL |

---

## 2. (a) The money surface behind `AGENCY_PAYOUTS_ENABLED` — is the UI honest?

**The guard.** `AgencyPayoutsEnabledGuard.canActivate` throws `NotFoundException` when the flag is off (agency-payouts-enabled.guard.ts:17-22) — a deliberate neutral 404, not a 403 "disabled" oracle. It is applied at class level on `AgencyPayoutsController` (agency-payouts.controller.ts:21) so all five money routes are inert. `requestPayout` re-checks the flag in the service as defence-in-depth (agency-payout.service.ts:138-140).

**How the seam interprets that 404.** `isPayoutsDisabled` (payer-api.ts, `/returned 404/`) maps it to `null` for all five reads. This is safe *only* because these routes have no per-resource 404 — they return the caller's own aggregate — which the seam documents explicitly.

**What the page renders.** `apps/payer-web/src/app/(portal)/agency/referrals/page.tsx`:
- lines 65-74: `getAgencyEarnings()` → `null` sets `payoutsEnabled = false`; a *thrown* error sets `earningsError = true`. The two are kept distinct.
- lines 79-83: KYC + payout history are read **only if** `earnings && payoutsEnabled` — so no cascade of 404s.
- lines 186-202: with the flag off it renders a `Card variant="flat" aria-disabled` headed **"Payouts coming soon"** with the copy *"Referral earnings and payouts aren't switched on yet. Keep sharing your referral link above…"*.

**Verdict: HONEST.** No ₹0 tile, no zero-state, no empty earnings table is rendered when the surface is gated. `EarningsPanel` — the only component that renders ₹ figures — is unreachable unless `earnings` is non-null (line 203-208), and even then it carries an always-visible **"Mock / No real money is disbursed"** disclosure (earnings-panel.tsx:32-38). A user cannot read "you have earned nothing" out of this page. The funnel (`AgencyInvitePanel`, `AgencyBatchInvitePanel`, the stat tiles) stays live above it, which is correct — those routes are ungated.

**Two caveats, neither fatal:**
1. The copy makes a forward promise — *"your mock rev-share will start accruing here"* (line 197-199) — while the parked card on the dashboard says the module needs *"real payments + product-ratified params"*. Same feature, two different stories.
2. `/agency/revenue` is a **second, independent** "Coming soon" shell (revenue/page.tsx:23-31) for the same subject, reachable from the dashboard "Revenue" tile which renders value `—` (agent-sections.tsx:202-216). Two parked surfaces for one feature.

**The honesty is broken elsewhere** — see (b).

---

## 3. (b) `profile/page.tsx` KYC + Bank cards — VERIFIED FABRICATED

`apps/payer-web/src/app/(portal)/profile/page.tsx` is 88 lines. Its complete import list (lines 1-5) is:

```
import Link from "next/link";
import { requirePayer } from "../../../lib/auth";
import { Avatar, Badge, Card } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { AccountForm } from "../account/account-form";
```

**There is no `payer-api` import at all.** `getAgencyKyc()` is never called. The rendered block, lines 55-85, verbatim:

```tsx
{session.role === "agent" ? (
  <section className="account-section">
    <h2 className="account-section__title">KYC &amp; Bank Details</h2>
    ...
      <Card className="account-stat" href="/agency/referrals" ariaLabel="KYC details — manage">
        ...
        <div className="account-stat__value">PAN &amp; Identity</div>
        <div className="account-stat__foot">
          <Badge tone="warning" upper>Pending</Badge>
          <span className="account-stat__hint">Submit your KYC documents</span>
        </div>
      </Card>

      <Card className="account-stat" href="/agency/referrals" ariaLabel="Bank details — add">
        ...
        <div className="account-stat__value">Not added</div>
        <div className="account-stat__foot">
          <Badge tone="neutral" upper>Not set</Badge>
          <span className="account-stat__hint">Add payout bank details</span>
        </div>
      </Card>
```

Every value — `"Pending"`, `"Not added"`, `"Not set"` — is a JSX string literal. Nothing is derived from server state.

**Is the user shown a fabricated KYC/bank status? Yes, in three distinct ways:**

1. **"Pending" is the wrong word even today.** This codebase's own vocabulary defines `pending` as *submitted and awaiting review*: `kyc-panel.tsx:159-167` renders the `pending` status as **"Under review — Your details are being reviewed."** The real backend enum for a never-submitted agency is `not_submitted` (agency-kyc.service.ts:66). So the profile page tells an agency its KYC is under review when nothing has been submitted and, with the flag off, nothing *can* be submitted.

2. **It will lie in the other direction after the flag flips.** Once `AGENCY_PAYOUTS_ENABLED=true` and ops runs `POST /ops/agency-kyc/:payerId/verify`, `GET /payer/agency/kyc` returns `status:"verified"` with real `panLast4`/`bankLast4` — and this page still renders "Pending" / "Not added" forever. An agency that has completed KYC and is eligible for payouts is told it has not.

3. **The CTA is a dead end.** Both cards link to `/agency/referrals`. With the flag off, that page renders the "Payouts coming soon" card (referrals/page.tsx:186-202) and **never mounts `KycPanel`** — there is no form. The hint "Submit your KYC documents" instructs the user to do something the product does not currently permit.

**Severity: P1**, not P0. No money moves, no PII is disclosed, and no security boundary is crossed — the backend gate is intact regardless of what this page paints. But it is a fabricated verification status on a financial/identity surface, it directly contradicts the honest gating on `/agency/referrals`, and it will misreport a *verified* agency the day the flag flips. This is exactly the "silently show a state a user would read as fact" failure the audit is looking for, and it is the only place in the agency surface where the UI is dishonest.

**Fix**: read `getAgencyKyc()` server-side; render `null` (gated 404) as the same "not enabled yet" card the referrals page uses, `not_submitted` as "Not submitted", and otherwise render the real status + masked last-4. Or delete the section and let `/agency/referrals` own KYC entirely.

---

## 4. (c) The referral / attribution chain, link by link

| Link | Implementation | State |
|---|---|---|
| **1. Agency mints an invite** | `POST /payer/agency/invites` / `…/batch` → `mintOneInvite` (agency.service.ts:477-485). Code = independent `randomUUID().replace(/-/g,"").slice(0,12)` (48-bit) per invite; returns `link: "/i/<code>"` | **LIVE** |
| **2. Link / QR built** | payer-web `inviteLandingUrl(code)` → `${NEXT_PUBLIC_SHORT_LINK_BASE}/i/<code>` (invite-landing.ts:87-89). `AgencyInvitePanel` copy/WhatsApp share (invite-panel.tsx:67, 220-231); `/agency/qr` QR + PNG download (qr-invite.tsx) | **LIVE** |
| **3. Recipient opens `/i/<code>`** | payer-web Server Component `app/i/[code]/page.tsx:89-116`. Outside `(portal)`, zero client JS, OG tags for WhatsApp, **byte-identical output for valid/invalid/expired codes** (no oracle) | **LIVE** |
| **4. Click recorded** | Landing page server-side `pingInviteClick` → `POST /invites/:code/click` (invite-landing.ts:148-164) → `InviteClickService.recordPublicClick` tries `invites` then falls through to `agency_invites` (invite-click.service.ts:55-64) → `AgencyService.recordInviteClick` advances `created→clicked` and emits `agency_invite.clicked` (agency.service.ts:628-651) | **LIVE** |
| **5. Play Store round-trip** | `playStoreUrl` attaches `referrer=bb_code=<code>` (invite-landing.ts:39-42); `intentUrl` provides the `intent://` fallback with the same payload encoded into `S.browser_fallback_url` (:109-115) | **LIVE** (server side) |
| **6. App reads the referrer** | worker-app `install_referrer_reader.dart` (`play_install_referrer`, `kInstallReferrerCodeParam='bb_code'`, one-shot via `kConsumedKey`) | **LIVE** (client; Flutter gates can't run locally, CI-only) |
| **7. Attribution posted** | worker-app `api_client.dart:891` → `POST /referrals/attribute` → `ReferralAttributionService.attribute` (:62-116): consent gate → `claimInstall` → worker seam → **agency seam** `attributeWorkerToInvite` (:102) | **LIVE** |
| **8. Consent gate** | Enforced **twice**: in the attribution service (referral-attribution.service.ts:75-78) and again inside the agency seam (agency.service.ts:685-691). Fail-closed on `!latest \|\| revokedAt !== null` | **LIVE** |
| **9. Accepted → funnel count** | `markAccepted` sets `status='accepted'`, `invited_worker_id`, `attributed_at` (agency-invites.repository.ts:82-93); emits `agency_invite.accepted` + `invite.install`, both keyed. Read back by `GET /payer/agency/referrals/summary` | **LIVE but the count is wrong — AG-04** |
| **10. Earnings accrual** | `findQualifyingUnlocks` joins `agency_invites` ⋈ `unlocks` on `invited_worker_id`, status `granted`, `granted_at` within `attributed_at + 90d` (agency-payout.repository.ts:56-82) | **FLAG-GATED-OFF** |
| **11. Payout request** | `requestPayout` gates on `AGENCY_PAYOUTS_ENABLED` + `kyc==='verified'` + `≥ ₹500`; claims accruals in a tx (agency-payout.repository.ts:162-209). MOCK — no disbursement rail | **FLAG-GATED-OFF** |
| **X. `referral_links` measurement spine** | `mintLink` (referral-link.service.ts:99-140) | **NO CALLER — claim VERIFIED** |

### `referral-link.service.ts` "NO HTTP CALLER, BY DECISION" — VERIFIED TRUE

`grep -rn "mintLink" --include=*.ts apps/` (excluding `dist/`) returns exactly three hits: the definition at referral-link.service.ts:99 and two lines inside its own unit test (referral-link.service.test.ts:352, 360). **No production caller exists.**

The stated consequence holds and compounds:
- `referral_links` is never written, so `resolve()`/`claimInstall()` always run the legacy `referral_link_id IS NULL` path (referral-link.service.ts:207-229).
- `referral.link_created` and `referral.link_clicked` **never fire in production**.
- `claimFirstTouch` can never match a link, so `claimInstall` always returns `{claimed:false, reason:"unknown_code"}` — and therefore `referral.install_claimed` **never fires either**.
- `GET /r/:code` (route 21) is live, tested, rate-limited, fail-safe code that **nothing points at**: `invite-landing.ts:76-85` documents that `/r/` URLs were 404ing on the payer-web origin and every share surface was moved to `/i/`.
- The two `REFERRAL_MATCH_WINDOW_*_HOURS` config values (packages/config/src/server.ts:189-190) govern a window that is never evaluated.

**Net**: the B4 first-touch/match-window measurement layer is entirely inert. Attribution still works — via the legacy `invites`/`agency_invites` funnels — but *without any window enforcement*, i.e. a code shared two years ago still attributes today. That is the deliberate "non-breaking by construction" split documented at referral-attribution.service.ts:80-90, but the practical result is that the window exists only on paper.

### Doc comments that are now FALSE

| Location | Claim | Reality |
|---|---|---|
| agency-invites.controller.ts:26-29 | attribution seam "is a tracked fast-follow; until it lands the seam has no caller, so no attribution occurs (fail-safe — it is exported but inert)" | **False.** referral-attribution.service.ts:102 calls it |
| agency.service.ts:661-662 | "That call site is a tracked fast-follow; until it is wired this exported method has no caller" | **False.** Same |
| agency.module.ts:74-76 | "Export the service so the worker consent/onboarding path *can* invoke…" | Now actually wired via `ReferralAttributionModule` (referral-attribution.module.ts:61) |
| payer-web server-config.ts:37-42 | `agencySupplyEnabled` — "the agency referrals page only reads this to LABEL its parked state… there is no referral/payout/KYC code behind it" | **False twice.** No page reads it (zero `.tsx` consumers), and referral/payout/KYC code all shipped |

---

## 5. (d) Two click sinks — which one runs, and what the public one costs

| | Public sink | Agent-gated sink |
|---|---|---|
| Route | `POST /invites/:code/click` | `POST /payer/agency/invites/:code/click` |
| Handler | messaging.controller.ts:79-97 | agency-invites.controller.ts:124-130 |
| Auth | **none** | `PayerAuthGuard` + `PayerRoleGuard` + `@PayerRoles("agent")` |
| Rate limit | `IpRateLimit("invite_click", 600/h)`, breach → drop the work, identical body | none |
| Code validation | `InviteCodeParamSchema` | `AgencyInviteCodeParamSchema` = `z.string().min(1).max(64)` — no shape check (dto:376-377) |
| Reaches agency funnel? | **Yes** — `InviteClickService` falls through worker→agency (invite-click.service.ts:55-64) | Yes, directly |
| Callers found | **payer-web `invite-landing.ts:153`**, server-side from `/i/[code]` | **ZERO, repo-wide** |

**payer-web calls the PUBLIC one.** The agent-gated one is dead code — the only reference to it anywhere is the explanatory comment at invite-click.service.ts:25 describing why it *couldn't* be the click path (an invited worker holds no agency session). TD113 fixed the funnel by making the public endpoint fall through; the agent-gated route was never removed.

**Abuse / attribution consequences of the public sink:**

1. **Funnel-count inflation is bounded, event volume is not.** `recordInviteClick` only advances `created→clicked` when `status==='created'` (agency.service.ts:633-635), so repeated clicks cannot inflate the *count*. But the `agency_invite.clicked` emit at :644-649 sits **outside** that conditional and is **deliberately unkeyed** — so every POST on a known code writes a fresh event row, forever, with no idempotency key and no per-code cap. An attacker holding one leaked code can write unbounded rows to the audit spine at 600/h/IP.
2. **Self-inflation by the agency.** The agency holds every code it minted. It can POST them all to the unauthenticated endpoint and move its entire funnel to `clicked`. No money follows (accruals key off `unlocks`, not clicks — agency-payout.repository.ts:56-82), so this is metric fraud, not payout fraud. But `clicked` is the funnel stat the agency is measured by.
3. **The rate limit protects almost nothing in the shipped topology.** The endpoint is only ever called *server-side by payer-web* (invite-landing.ts:153). With `TRUST_PROXY_HOP_COUNT=0` (the default), every legitimate scan collapses into payer-web's single egress IP — one bucket for all traffic — which the controller comment states outright at messaging.controller.ts:71-77. So the 600/h cap can shed real workers at a busy factory gate while doing nothing about a direct attacker who has their own IPs.
4. **Enumeration is not practical.** 48-bit codes, and `InviteCodeParamSchema` plus the byte-identical `{ok:true}` response for hit/miss/error/rate-limit means there is genuinely no oracle. This part is well built.
5. **The dead agent-gated route is a latent footgun**, not a live hole: it is agent-authed and neutral, but it accepts any 1–64-char string as a code and would let an agent probe *other agencies'* code spaces if `recordInviteClick` ever became distinguishable. It should be deleted.

---

## 6. (e) `GET /payer/agency/workers` — can any PII reach the agency? **No.**

Four independent layers, each read and verified:

1. **The SQL projection never reads PII** (agency-workers.repository.ts:58-100). Selected columns are exactly: `ai.invited_worker_id`, an `EXISTS` on `worker_profiles.profile_status='confirmed'`, `count(*)` over `applications`, `count(*)` over `unlocks` (`status IN ('granted','revealed')`), and `to_char(date_trunc('day', max(last_seen_at) AT TIME ZONE 'UTC'),'YYYY-MM-DD')`. `workers.full_name_enc`, `phone_hash`, `job_postings.org_label` and applied-job ids are never in the FROM/SELECT.
2. **The consent gate is inside the join, not above it** (:107-121): `EXISTS (SELECT 1 FROM worker_consents WHERE revoked_at IS NULL AND jsonb_exists(purposes,'agent_activity_visibility') AND accepted_at = MAX(...))`. A non-consenting worker is never *selected*, so a late refactor cannot drop the filter without changing the row count.
3. **Pseudonymisation + order-scrubbing** (agency-workers.service.ts:68, 92-101). `ref = pii.hmac("agency_worker:<payerId>:<workerId>").slice(0,16)` — keyed, per-agency, so two agencies referring the same man get unrelated handles and cannot join their lists. The raw uuid never leaves the service. The response is then **re-sorted by `(lastActiveOn, ref)`**, discarding the SQL's `invited_worker_id ASC` tiebreak — because an agency is also a payer and holds real `workers.id` values from the applicant/unlock surfaces, and a uuid-derived row order inside a tie group would de-pseudonymise by alignment.
4. **Two `assertNoAgencyPII` crossings + a strict re-projection.** payer-api.ts uses a deliberately **lenient** transport schema (`agencyWorkerWireSchema.passthrough()`) so a regressed backend key *survives* to the guard instead of being silently stripped by zod, then applies `assertNoAgencyPII`, then re-parses with the strict `agencyWorkerListWireSchema` so exactly five fields reach the UI. The page crosses the guard a second time (workers/page.tsx:58).

**Residuals, stated honestly:**
- The repository comment itself (:131-139) concedes that *membership* under `LIMIT 200` is still uuid-derived — degraded to "is my known worker in my own top-200 referrals", which the agency already knows.
- **`assertNoAgencyPII` is KEY-ONLY.** `scrub()` passes every primitive through unchanged (assert-no-agency-pii.ts:108) and matching is a lowercase substring test over the *key* (`keyLooksLikePii`, :72-76). PII sitting in a *value* under a benign key — e.g. a `campaign` tag containing a name and phone number — is invisible to it. That does not affect this route (its five fields are booleans/counts/HMAC/date), but the guard is weaker than its "last-line" framing implies wherever free-text values ride.
- The guard's `ALLOWED_KEY_EXACT` correctly allow-lists `panlast4` / `banklast4` while keeping raw `pan`/`bank`/`ifsc` forbidden (:64-69).

**The route is nevertheless inert.** `agent_activity_visibility` is defined in `packages/types/src/index.ts:55` and referenced only there, in the two backend files that read it, and in payer-web comments. **No client ever requests it** — grep across `apps/`, `packages/` (incl. `.dart`, `.sql`) finds no write path. `CURRENT_CONSENT_VERSION` was deliberately not bumped (packages/types/src/index.ts:81-95) because the notice copy is outstanding owner/legal work. So the projection returns `[]` for every agency, always. The UI handles that honestly (workers/page.tsx:83-103 distinguishes `null` = failed from `[]` = none; the dashboard tile shows no count at all, agent-sections.tsx:182-201) — but a shipped surface that cannot ever produce a row is a launch gate, not a feature.

---

## 7. (f) PARKED (label-only) vs genuinely missing

### Label-only, no code path
| Surface | File | What it is |
|---|---|---|
| **Parked module cards** — KYC, Payouts, Bulk Invite Upload, Matching/Outcome Tracking | dashboard/parked-modules.tsx:31-52 | Four `Card variant="flat" aria-disabled` inside a `<details open>`. No DS Button, no link. Badge flips between "Parked" and "Flagged on — still unbuilt" (:74-76) |
| **`/agency/revenue`** | revenue/page.tsx:9-34 | `requireAgent()` + `agencyPortalEnabled` check, then a single "Coming soon" card. **Reads no session data, calls no seam** |
| **Dashboard "Revenue" tile** | agent-sections.tsx:202-216 | Renders value `—`, links to the above |

### Dead by design, honestly labelled — the best example in the repo
`agency/bulk-upload/page.tsx:26-58`. It does **not** say "coming soon". It says *"Not available: consent violation… This is not pending a release — it will not be built"* (:39-44), then renders a second, `tone="success"` card pointing at the **live** batch-mint (`/agency/referrals#batch-invites`) as the opposite-shaped answer to the same need (:46-57). The route is deliberately kept so the dashboard tile and bookmarks land on the explanation rather than a 404.

### The parked labels are now STALE and self-contradicting
`parked-modules.tsx:33-42` says **KYC** is *"Parked: legal/DPDP sign-off required"* and **Payouts** is *"Parked: real payments + product-ratified params required"*. Both are **built and shipped** — `AgencyKycService`, `AgencyPayoutService`, `KycPanel`, `EarningsPanel`, `PayoutPanel`, migrations, ops verify queue — and merely flag-gated. The header comment (:6-12) even asserts *"a flag being ON would still build NOTHING"*, which is false for these two: `AGENCY_PAYOUTS_ENABLED=true` immediately arms a real KYC collection form and a payout ledger. An agent reading the dashboard is told a feature does not exist while the adjacent page tells them it is "coming soon" and the profile page tells them their KYC is "Pending".

### The `NEXT_PUBLIC_ENABLE_AGENCY_*` flags gate nothing
`agencyKycEnabled`, `agencyPayoutsEnabled`, `agencyBulkUploadEnabled`, `agencyOutcomeTrackingEnabled` are consumed **only** by `parked-modules.tsx:35,40,45,50` to pick a badge string. `agencySupplyEnabled` (config.ts:88 and separately server-config.ts:59) has **zero consumers**. All real gating is server-side (`AGENCY_PAYOUTS_ENABLED`, `agencyPortalEnabled`).

### Genuinely missing (no page, no route, no stub)
- **Pagination** on `GET /payer/agency/jobs`, `GET /payer/agency/payouts` (unbounded) and a cursor for `GET /payer/agency/workers` (hard `LIMIT 200`, no way to reach row 201).
- **Reopen a job** — `JobStatus` is `open|closed` and `closed` is terminal (agency.service.ts:229-232); pause == close with no inverse (:353-360).
- **Agency-side analytics** beyond the three funnel counts.
- **`job.available` fan-out for agency jobs** — TD64, explicitly deferred in code (agency.service.ts:193-196): an agency vacancy notifies no matched worker.
- **Real payout disbursement rail** — every ₹ is mock (agency-payout.service.ts:41-44); a §7 gate.
- **Real KYC registry verification** — ops `verify` is a mock human ack (agency-kyc.service.ts:129-131).
- **Applicant route** — deliberate: agency jobs reuse the shipped `/payer/reach/jobs/:jobId/applicants` (agency-jobs.controller.ts:23-26).

---

## 8. Test coverage for this dimension

**Present (colocated, apps/api/src/agency + referrals):** agency.service.test.ts, agency.dto.test.ts, agency-invites-batch.test.ts, agency-invites-batch-cap.test.ts, agency-no-per-invite-oracle.test.ts, agency-role-authz.test.ts, agency-workers.service.test.ts, agency-kyc.service.test.ts, agency-kyc.repository.test.ts, agency-kyc-ops.controller.test.ts, agency-payout.service.test.ts, agency-payouts.controller.test.ts, agency-payouts-enabled.guard.test.ts, referral-attribution.{service,controller,module.boot}.test.ts, referral-link.{service,repository}.test.ts, referral-resolve{r.controller,}.test.ts, referral-bonus.{service,repository,processor}.test.ts, invite-click.service.test.ts, messaging.controller.test.ts.

**Missing:**
- **No repository test for `agency-workers.repository.ts`** — the DPDP consent gate lives in raw `sql` (lines 107-121) and is the single most security-critical statement on the agency surface. No unit test executes it. Its own comments record two bugs found only by replaying against a real Postgres (`profile_status` vs `status` at :61-63; the IST timezone day-shift at :87-93) — evidence that this file's correctness has historically depended on manual replays.
- No repository tests for `agency-jobs.repository.ts`, `agency-invites.repository.ts`, `agency-payout.repository.ts` (including the race-safe claim transaction at :162-209).
- **No agency E2E at all.** `tests/e2e/` has 12 suites; only `referral-round-trip.e2e.test.ts` touches this chain and it is `describe.skipIf(!RUN)`. `payer-tenancy.e2e.test.ts` is a hard `describe.skip` (:93).
- payer-web has SSR tests for the panels (kyc-panel.test.tsx, payout-panel.test.tsx, earnings-panel.test.tsx, referrals-parked.test.tsx, referral-funnel.test.tsx, dashboard.test.tsx, worker-activity-list.test.tsx) but **no test asserts the profile page's KYC section**, which is why AG-06 survived.
