# Route Register (full audit) — apps/payer-web

**Status:** COMPLETE (audited 2026-08-11, dimension re-run after the usage-limit interruption).
**Method:** evidence-based static analysis; every claim carries a `file:line` citation.
**Findings feed** `GAP_REGISTER.md`. Coverage caveats: `AUDIT_STATUS.md`.

---

# payer-web ROUTE REGISTER + per-route UI completeness

## Executive summary
apps/payer-web has exactly 25 addressable routes: 4 public and 21 under `(portal)` (one of which is a pure redirect shim). Of the 21 portal routes, 12 are fully wired and usable, 2 are honest parked shells, 2 are unreachable dead ends in staging/production, 1 duplicates another, 1 is orphaned from all navigation, and 3 carry unwired or hardcoded data. The most consequential defect is confirmed: `getOrgRole()` (apps/payer-web/src/lib/auth/org-roles.ts:46-56) hard-returns "recruiter" outside dev — its own test asserts this at org-roles.test.ts:60-64 — so `requireOwner()` notFound()s every real user, killing /credits and /team outright. portal-nav.tsx:51-56 correctly hides those nav links, but six OTHER hrefs still point at /credits (dashboard tile at dashboard/page.tsx:81, both "Buy" CTAs on /plans at plans/page.tsx:215, two "Top up" links at applicant-actions.tsx:212 and :482), so every credit-purchase path in the product 404s. On Server Actions the news is better than feared: I read all 16 "use server" modules and all 34 exported actions individually — 15 re-assert their own gate as the first statement (credits x3, team x3, capacity x1, agency x8), 3 are the deliberately public login actions, 1 is logout, and the remaining 15 rely on payerFetch's httpOnly-cookie Bearer for authentication. That is NOT an authorization bypass (every one touches a role-shared surface and the API re-derives tenancy from req.payer.id), but it produces a real defect: `isPayerUnauthorized` is referenced in exactly ONE place repo-wide (http-provider.ts:134), so an expired cookie inside those 15 actions collapses to a generic "Please retry" and the user is never sent to /login. Error/loading coverage is thin but not absent: one loading.tsx and one error.tsx for the whole (portal) group, plus root error.tsx/global-error.tsx/not-found.tsx — zero per-route boundaries, and no loading state at all on /login or /i/[code]. Data integrity has one severe hole: toPostingSummary (payer-api.ts:947-957) hardcodes applicantCount: 0 and drops applicantQuota even though the backend computes and returns both (payer-job-postings.controller.ts:22 + enrich() at :76-85), so every posting on /dashboard, /postings and /postings/[id] permanently reads "0 applicants". No list page anywhere has pagination, filtering or search; the backend's ?status= filter on /payer/job-postings is never sent. Destructive actions are inconsistently confirmed: unlock-spend and both mock-money buys prompt, but Close posting, Close/Pause vacancy, Remove member and Request payout do not.

> Scope: `apps/payer-web` only. Every claim below was verified by opening the cited file. Read-only audit; nothing was written.

---

# 1. Route register (all 25 routes)

Legend for **Gate**: the *first* auth statement executed for that route. Every `(portal)/**` route additionally inherits `requirePayer()` from `apps/payer-web/src/app/(portal)/layout.tsx:34`.

## 1.1 Public routes (outside `(portal)`)

| URL | Page file | Gate | Data fns | Server Actions | loading | error | not-found | Empty | Error state | Success state | Validation (client / server) | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/` | `src/app/page.tsx` | none — `payerAuth().currentSession()` (`:8`) | `currentSession` | — | ✗ | root `app/error.tsx` | `app/not-found.tsx` | n/a | n/a | `redirect("/dashboard"\|"/login")` (`:9`) | n/a | none | **OK** |
| `/login` | `src/app/login/page.tsx` | none (redirects out if session, `:44-45`) | `currentSession` | `requestCodeAction`, `signupAction`, `verifyCodeAction` (`login/actions.ts`) | ✗ | root `app/error.tsx` | root | n/a | neutral single-string error (`login/messages.ts`) | 2-step OTP → `router` nav | client in `login-form.tsx`; server zod `actions.ts:20-26` | `login/page.test.tsx`, `login-form.test.tsx`, `login/actions.test.ts` | **OK** |
| `/i/[code]` | `src/app/i/[code]/page.tsx` | none (deliberately unauth, `:31-33`) | `pingInviteClick` (`:95`), `isWellFormedInviteCode` (`:101`) | — | ✗ | root `app/error.tsx` | n/a — renders identically for any code (no-oracle, `:29-32`) | n/a — no data rendered | best-effort ping, failure invisible (`:92-95`) | anchor to Play Store (`:127-133`) | n/a | `i/[code]/page.test.tsx` | **OK** |
| `/i/[code]/desktop` | `src/app/i/[code]/desktop/page.tsx` | none | `pingInviteClick` (`:53`), `inviteLandingUrl` (`:58`) | — | ✗ | root | n/a (same no-oracle rule, `:24-26`) | n/a | invisible | QR + typed URL (`:70-86`) | n/a | **none** | **OK (untested)** |

## 1.2 Portal routes — shared (employer + agent)

| URL | Page file | Gate | Data fns | Server Actions | loading | error | not-found | Empty | Error | Success | Validation | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard` | `(portal)/dashboard/page.tsx` | `requirePayer()` `:38` | `getDashboard()` `:44` | — (agent branch renders `AgentSections`) | group `(portal)/loading.tsx` | group `(portal)/error.tsx` | n/a | `dash-empty` cards `:137`, `:183` | in-page `Service unavailable` + `RetryButton` `:49-63` | n/a (read-only) | n/a | `dashboard/page.test.tsx`, `agent-sections.test.tsx` | **BROKEN DATA** — `/credits` tile is a dead link (`:81`); every posting card shows `0 applicants` (`:205`) |
| `/profile` | `(portal)/profile/page.tsx` | `requirePayer()` `:10` | session only | `updateAccountAction` (via `AccountForm`) | group | group | n/a | n/a | `Service unavailable` when `!session.email` `:12-27` | `saved` flag + `router.refresh()` | client `account-form.tsx:91-98`; server `account/actions.ts:36-58` | **none** | **DUPLICATE** of `/account`; KYC cards hardcode `Pending`/`Not added` `:68`,`:79` |
| `/account` | `(portal)/account/page.tsx` | `requirePayer()` `:23` | session only | `updateAccountAction` | group | group | n/a | n/a | `:27-42` | same | same | `account/page.test.tsx`, `account-form.test.tsx` | **OK** (same hardcoded KYC cards `:83`,`:94`) |
| `/postings` | `(portal)/postings/page.tsx` | `requirePayer()` `:29` | `getLiveCatalog()` `:31`, `getPostings()` `:37` | `pause/resume/topUpQuota/closePostingAction` | group | group | n/a | `postings-empty` `postings-manager.tsx:97-107` | `:69-81` + `RetryButton` | per-row `aria-live` notice `postings-manager.tsx:200-203` | n/a (no form) | `postings-manager.test.tsx`, `postings/actions.test.ts` | **BROKEN DATA** — every row shows `0 / —` applicants (`postings-manager.tsx:130-131`); no pagination/filter |
| `/postings/new` | `(portal)/postings/new/page.tsx` | **none of its own** — layout only | `getLiveCatalog` `:34`, `getCapacity` `:40`, `listMatchSkills` `:55` | `createPostingAction`, `previewReachAction` | group | group | n/a | skill-list failure → explicit reload prompt + disabled submit `posting-form.tsx:368-373` | inline `posting-form__error` `:404` | `router.push('/postings/{id}/applicants')` `:225` | full client `validate()` `posting-form.tsx:87-155`; server `createPostingInputSchema` + `matchSelectionInputSchema` `actions.ts:45-69` | `posting-form.test.tsx` (component only, no page test, no action test) | **OK** |
| `/postings/ai/new` | `(portal)/postings/ai/new/page.tsx` | `requirePayer()` `:23` | `getJobPostingChatSessions()` `:29` | 4 chat actions | group | group | n/a | start-fresh path when no sessions `:35-37` | `loadFailed` honest note `:31`,`:50` | `router.push('/postings/{id}')` `job-posting-chat.tsx:193` | server `jobPostingChatMessageInputSchema` `actions.ts:66` | `job-posting-chat.test.tsx` (component only) | **INCOMPLETE** — publish attaches NO match skills (see §5) |
| `/postings/[id]` | `(portal)/postings/[id]/page.tsx` | `requirePayer()` `:34` | `getPosting(id)` `:38` | — | group | group | `notFound()` on non-uuid `:37` and on `null` `:39` | n/a | uncaught throw → group boundary | n/a | uuid guard `:37` | **none** | **BROKEN DATA** — `Applicants` row always `0 / —` (`:61-62`) |
| `/postings/[id]/edit` | `(portal)/postings/[id]/edit/page.tsx` | `requirePayer()` `:38` | `getPostingDraft(id)` `:43` | `updatePostingAction` | group | group | `notFound()` `:42`,`:44` | n/a | inline `aria-live` `edit-posting-form.tsx:109` | `router.push('/postings/{id}')` `:70` | client `validate()` `:40-48`; server `updatePostingInputSchema` `actions.ts:35-50` | `edit-posting-form.test.tsx`, `edit/actions.test.ts` | **OK** |
| `/postings/[id]/applicants` | `(portal)/postings/[id]/applicants/page.tsx` | **none of its own** — layout only (`:18`) | `getApplicantFeed(id)` `:28`, `getDashboard()` `:36` | `unlockAction`, `revealContactAction`, `maskedResumeAction` | group | group | in-page neutral card `:50-53` (not a 404) | `No applicants on this posting yet` `:87-90` | `:54-63` + `RetryButton` | `ConfirmSpendDialog` → result Toast `applicant-actions.tsx:505` | server uuid guards `actions.ts:37`,`:57`,`:82` | `applicant-feed.test.tsx`, `applicant-actions.test.tsx`, `unlock-ux.test.tsx` — **no action test** | **PARTIAL** — pipeline + reveal are client-local only (§6); `id` not uuid-guarded before the authed path (§7) |
| `/plans` | `(portal)/plans/page.tsx` | `requirePayer()` `:20` | `getLiveCatalog()` `:25`, `getCapacity()` `:32` | `upgradeCapacityAction` (via `CapacityPanel`) | group | group | n/a | 4 distinct empty cards `:116`,`:184`,`:201`,`:231` | `:56-65` + `RetryButton` | `router.refresh()` `capacity-panel.tsx:54` | n/a | **none** | **BROKEN LINK** — every credit-pack `Buy` → `/credits` 404 (`:215-217`); `upgradeCapacityAction` revalidates `/capacity`, not `/plans` |
| `/capacity` | `(portal)/capacity/page.tsx` | `requirePayer()` `:33` | `getLiveCatalog()` `:40`, `getCapacity()` `:46` | `upgradeCapacityAction` | group | group | n/a | `capacity-empty` `:141-147` | `:65-74` + `RetryButton` | `window.confirm` → Toast + `router.refresh()` | tier-code value guard `actions.ts:39-43` | `capacity-page.test.tsx`, `capacity/actions.test.ts` | **ORPHANED** — not in `portal-nav.tsx`; only inbound link is `postings/new/page.tsx:100` |
| `/credits` | `(portal)/credits/page.tsx` | **`requireOwner()` `:49`** | `getLiveCatalog` `:53`, `getDashboard` `:61`, `getCreditTopUps` `:70` | `topUpAction`, `createOrderAction`, `verifyPaymentAction` | group | group | **404s for every real user** | `credits-empty` `credits-panel.tsx:143-146` | `:108-117` + `RetryButton` | Toast + `router.refresh()` `credits-panel.tsx:63`,`:121` | `packCodeSchema` `actions.ts:24` | `credits/page.test.tsx`, `credits/actions.test.ts` | **DEAD (P0)** |
| `/team` | `(portal)/team/page.tsx` | **`requireOwner()` `:17`** | `listOrgMembers()` `:18` — **no try/catch** | `inviteMemberAction`, `removeMemberAction` | group | group | **404s for every real user** | `team-empty` `team-manager.tsx:85-88` | none in-page — a failed read escapes to the group boundary | `aria-live` message card `team-manager.tsx:74-80` | server `emailSchema`/`memberIdSchema` `actions.ts:20-21` | `team-manager.test.tsx`, `team/actions.test.ts` | **DEAD (P0)** |
| `/team/accept` | `(portal)/team/accept/page.tsx` | `requirePayer()` `:19` — **NOT owner-gated (verified)** | `searchParams.token` `:20` | `acceptInviteAction` | group | group | missing-token card `accept-invite.tsx:27-35` | n/a | inline neutral card `:56-60` | success card + `/dashboard` link `:37-46` | server `tokenSchema` `actions.ts:22` | **none** | **REACHABLE but ORPHANED** — no owner can ever send an invite, because `/team` is dead |

## 1.3 Portal routes — agency-only

| URL | Page file | Gate | Flag gate | Data fns | Server Actions | Empty | Error | Success | Tests | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|
| `/agency/dashboard` | `(portal)/agency/dashboard/page.tsx` | none — `redirect("/dashboard")` `:23` | — | — | — | n/a | n/a | redirect | `dashboard.test.tsx` | **OK (shim)** |
| `/agency/referrals` | `(portal)/agency/referrals/page.tsx` | `requireAgent()` `:47` | **MISSING** `agencyPortalEnabled` check | `getAgencyReferralsSummary` `:55`, `getAgencyEarnings` `:69`, `getAgencyKyc`+`listAgencyPayouts` `:80` | `createInviteAction`, `createInviteBatchAction`, `submitKycAction`, `requestPayoutAction` | `No payout requests yet` `payout-panel.tsx:113` | 3 isolated degrade cards `:166`,`:179`,`:124` | `revalidatePath('/agency/referrals')` + `router.refresh()` | `kyc-panel/payout-panel/earnings-panel/referrals-parked/*-invite-panel.test.tsx`, `supply-actions.test.ts` | **OK, gated OFF** (`AGENCY_PAYOUTS_ENABLED` default off → "coming soon" `:186-202`) |
| `/agency/workers` | `(portal)/agency/workers/page.tsx` | `requireAgent()` `:48` | `notFound()` if off `:52` | `listAgencyWorkers()` `:58` | — | first-class honest empty `worker-activity-list.tsx:24-42` | `:83-89` + `RetryButton` | n/a | `workers/page.test.tsx`, `worker-activity-list.test.tsx` | **OK** — capped at 200 rows, disclosed `:95-97` |
| `/agency/revenue` | `(portal)/agency/revenue/page.tsx` | `requireAgent()` `:10` | `notFound()` if off `:13` | none | — | n/a | n/a | n/a | **none** | **PARKED (honest)** |
| `/agency/qr` | `(portal)/agency/qr/page.tsx` | `requireAgent()` `:23` | `notFound()` if off `:25` | none | `createInviteAction` | n/a | inline error region | printable QR sheet | `qr-invite.test.tsx` | **OK** |
| `/agency/bulk-upload` | `(portal)/agency/bulk-upload/page.tsx` | `requireAgent()` `:21` | `notFound()` if off `:24` | none | — | n/a | n/a | n/a | **none** | **DEAD BY DESIGN (honest)** `:39-43` |
| `/agency/jobs/[jobId]` | `(portal)/agency/jobs/[jobId]/page.tsx` | `requireAgent()` `:32` | **MISSING** | `getAgencyJob(jobId)` `:36` | — | n/a | `notFound()` `:35`,`:37` | n/a | **none** | **OK** (uuid-guarded `:35`) |

---

# 2. (a) DEAD / unreachable routes — with proof

### 2.1 `getOrgRole()` is a production stub → `/credits` and `/team` are unreachable

```ts
// apps/payer-web/src/lib/auth/org-roles.ts:46-56
export function getOrgRole(_session: PayerSession): OrgRole {
  if (isDevEnv()) {                                    // :49
    const override = (process.env[DEV_ORG_ROLE_ENV] ?? "")...
    if (override === "owner") return "owner";          // :51  <-- dev/test ONLY
    ...
  }
  return "recruiter";                                  // :55  <-- ALWAYS in staging/prod
}
```
`requireOwner()` (`org-roles.ts:64-70`) calls `getOrgRole(session) !== "owner"` → `notFound()`.

The behaviour is **asserted by the repo's own test**:
- `org-roles.test.ts:60-64` — *"IGNORES the override outside dev/test"*: with `NODE_ENV=production`, `getOrgRole` returns `"recruiter"`.
- `org-roles.test.ts:79-83` — `requireOwner()` rejects with `NEXT_NOT_FOUND` for a recruiter.

Consequences, both confirmed by reading the pages:
- `credits/page.tsx:49` — `await requireOwner();` is the first statement. **`/credits` renders `app/not-found.tsx` for 100 % of real users.**
- `team/page.tsx:17` — `await requireOwner();`. **`/team` is likewise 404 for 100 % of real users.**
- All three credits Server Actions also gate on `requireOwner()` (`credits/actions.ts:42`, `:90`, `:126`), so even a hand-crafted POST to `topUpAction` / `createOrderAction` / `verifyPaymentAction` 404s. **There is no reachable credit-purchase path in staging or production, mock or real.**
- Both team write actions gate on `requireOwner()` (`team/actions.ts:27`, `:38`), so **no one can invite or remove a teammate.**

### 2.2 `/team/accept` is NOT affected — verified

`team/accept/page.tsx:19` calls `await requirePayer()`, not `requireOwner()`. `acceptInviteAction` likewise gates on `requirePayer()` (`team/actions.ts:48`). So the accept page works for any logged-in payer — but it is **functionally orphaned**: the only producer of accept tokens is `inviteMemberAction`, which is dead per §2.1. The invite-acceptance loop can never begin.

### 2.3 Dead links in the nav — the nav itself is CLEAN, other surfaces are not

`portal-nav.tsx:51-56` pushes `/credits` and `/team` **only when `isOwner`**, and `layout.tsx:37` computes `isOwner` from the same stubbed `getOrgRole`. So the primary nav does **not** render dead links. `layout.test.tsx:117-122` pins this.

But six other `href="/credits"` sites do not consult `isOwner` (full grep of `apps/payer-web/src`, excluding tests):

| # | File:line | Surface | User-visible copy |
|---|---|---|---|
| 1 | `(portal)/dashboard/page.tsx:81` | `StatTile` "Credit balance" — whole tile is the link | "Credit balance … open wallet" |
| 2 | `(portal)/plans/page.tsx:215-217` | **Every credit pack's primary `Buy` button** | "Buy" |
| 3 | `(portal)/postings/[id]/applicants/applicant-actions.tsx:212` | Zero-balance nudge in the applicant feed | "**Top up** to unlock a candidate's routed contact" |
| 4 | `(portal)/postings/[id]/applicants/applicant-actions.tsx:482` | Per-row unlock guidance | "**Top up to unlock**" |

(#2 counts once per rendered pack, #1/#3/#4 once each.) This is a **dead-link UX defect layered on top of the functional one**: the payer is explicitly told to top up, clicks, and lands on "Not found — this page doesn't exist, or isn't available to your account."

`grep 'href="/team"'` outside `portal-nav.tsx` returns **zero** hits, so `/team` has no dead inbound link.

### 2.4 Other reachability findings

- **`/capacity` is orphaned from navigation.** `portal-nav.tsx:48` links `/plans`, never `/capacity`. The only inbound `href="/capacity"` in the whole app is `postings/new/page.tsx:100`, inside an `atCapacity` conditional. `/plans` already renders the same `CapacityPanel` (`plans/page.tsx:120`) plus the same capacity stats, so `/capacity` is a near-duplicate reachable only via a rare banner.
- **`/profile` duplicates `/account`.** `profile/page.tsx:29-87` and `account/page.tsx:44-102` render the same `AccountForm` with the same props and the same agency KYC cards. `/profile` is in the nav (`portal-nav.tsx:31`); `/account` is reachable from the account menu (`account-menu.tsx:132`) and the agent dashboard (`agent-sections.tsx:116`). Two URLs, one screen, two different entry points.
- **`/agency/dashboard`** is a live `redirect("/dashboard")` (`:23`) — intentional, documented, fine.

---

# 3. (b) Error boundaries and loading states — exhaustive glob

`git ls-files` for `loading.tsx` / `error.tsx` / `not-found.tsx` / `template.tsx` / `default.tsx` / `route.ts` / `middleware.ts` under `apps/payer-web` returns exactly:

| File | Scope it covers |
|---|---|
| `src/app/(portal)/loading.tsx` | ALL 21 portal routes (one shared skeleton) |
| `src/app/(portal)/error.tsx` | ALL 21 portal routes |
| `src/app/error.tsx` | root segment — `/`, `/login`, `/i/**` |
| `src/app/global-error.tsx` | root-layout failure (owns its own `<html>`) |
| `src/app/not-found.tsx` | unknown routes + every `notFound()` from a gate |
| `src/app/(portal)/layout.tsx` | the only nested layout |

**There is no `middleware.ts`, no `template.tsx`, no `default.tsx`, and no Route Handler (`route.ts`) anywhere in the app.**

Gaps:
1. **Zero per-route `loading.tsx`.** Every portal route — `/dashboard`, `/postings`, `/credits`, `/agency/referrals`, `/postings/[id]/applicants` — shows the identical generic 3-card skeleton from `(portal)/loading.tsx:8-25`. A deep route with a heavy fan-out (`/agency/referrals` awaits up to 4 reads, `:55`/`:69`/`:80`) is visually indistinguishable from `/dashboard`.
2. **No loading state at all on the public surface.** `/login` and `/i/[code]` have no `loading.tsx` at any level. `/i/[code]` is explicitly designed for "a ₹7k phone on 3G" (`i/[code]/page.tsx:33-37`) yet `await pingInviteClick(code)` (`:95`) blocks the whole render with no fallback.
3. **Zero per-route `error.tsx`.** A failure on `/credits` and a failure on `/agency/workers` produce byte-identical output. That is deliberate for no-leak reasons (`(portal)/error.tsx:3-9`) but it means there is no route-scoped recovery affordance beyond `reset()`.
4. **One page does a bare, uncaught read**: `team/page.tsx:18` — `const members = await listOrgMembers();` with no try/catch, so a transient org-API failure blows the whole segment to the error boundary instead of the in-page `RetryButton` pattern every sibling page uses. (Masked today by the `requireOwner()` 404.)

Only `error-boundaries.test.tsx` covers any of this, with a single assertion (`:82`).

---

# 4. (c) Refresh / direct-navigation / back-forward with an expired cookie

**The 401 path, traced end to end:**

```
payer-http.ts:50   if (!token) throw new PayerUnauthorizedError();
payer-http.ts:61   if (res.status === 401) throw new PayerUnauthorizedError();
payer-http.ts:29   export function isPayerUnauthorized(err)  <-- ONE consumer repo-wide
http-provider.ts:133-138  catch (err) { if (isPayerUnauthorized(err)) return null; ... return null; }
auth/index.ts:27   if (!session) redirect("/login");
```

`grep isPayerUnauthorized apps/payer-web/src` (excluding tests) returns exactly two files: its definition (`payer-http.ts:29`) and its one call site (`http-provider.ts:134`).

### Hard refresh of a deep route (e.g. `/postings/abc.../applicants`) with an expired cookie

1. Next renders `(portal)/layout.tsx`. Line 34 → `requirePayer()` → `currentSession()` → `GET /payer/me` returns 401 → `payerFetch` throws → caught at `http-provider.ts:134` → `null` → `auth/index.ts:27` → **`redirect("/login")`**.
2. The layout redirect short-circuits the segment, so the user lands on `/login` — **correct behaviour, no error screen.**
3. The page's own reads race the layout. `applicants/page.tsx:28` `getApplicantFeed(id)` would also throw `PayerUnauthorizedError`, and its `catch` at `:30` sets `feedError = true` → "Service unavailable" — but the layout's redirect wins the response.
4. Every portal page is `export const dynamic = "force-dynamic"`, so there is no stale RSC payload to serve on back/forward; the layout gate re-runs and re-redirects. Back-forward is safe.

**Verdict on refresh/direct-nav: the user gets `/login`, not an error screen. This part is correct.**

### The real hole: expired cookie *inside* a Server Action

There is **no route-level protection for a Server Action** — it is an independently invocable POST. Two behaviours split by whether the action gates:

- **The 15 gated actions** (credits ×3, team ×3, capacity ×1, agency ×8) start with `requireOwner()`/`requirePayer()`/`requireAgent()`, all of which funnel through `requirePayer()` → `redirect("/login")`. **Correct.**
- **The 15 ungated actions** (see §5) call `payerFetch` directly. The thrown `PayerUnauthorizedError` is swallowed by a bare `catch` and mapped to generic retry copy:
  - `postings/actions.ts:47-50` → *"Could not pause the posting right now. Please retry."*
  - `postings/[id]/applicants/actions.ts:43-45` → *"Unlock failed (service unavailable). Please retry."*
  - `account/actions.ts:68-71` → `ACCOUNT_SAVE_ERROR`
  - `postings/[id]/edit/actions.ts:68` → *"Could not save the changes right now. Please retry."*

  The payer sits on a rendered page whose session is gone, clicks Pause/Unlock/Save, is told to retry, and retries forever. Nothing ever redirects them to `/login`. **This is the concrete consequence of `isPayerUnauthorized` having exactly one consumer.**

---

# 5. (d) Server Actions — every action, individually

16 `"use server"` modules, **34 exported actions**. Read individually.

## 5.1 Actions that DO re-assert their own gate (15)

| Action | File:line of gate | Gate | zod input | revalidate / redirect | Typed error to form |
|---|---|---|---|---|---|
| `topUpAction` | `credits/actions.ts:42` | `requireOwner()` | `packCodeSchema` `:44` | none (client `router.refresh()`) | `{ok:false,error}` |
| `createOrderAction` | `credits/actions.ts:90` | `requireOwner()` | `packCodeSchema` `:92` | none | `{ok:false,error}` |
| `verifyPaymentAction` | `credits/actions.ts:126` | `requireOwner()` | inline `z.object` `:128-132` | none | `{ok:false,error}` |
| `inviteMemberAction` | `team/actions.ts:27` | `requireOwner()` | `emailSchema` `:28` | **none — defect** | `{ok,message}` |
| `removeMemberAction` | `team/actions.ts:38` | `requireOwner()` | `memberIdSchema` `:39` | **none — defect** | `{ok,message}` |
| `acceptInviteAction` | `team/actions.ts:48` | `requirePayer()` | `tokenSchema` `:49` | none | `{ok,message}` |
| `upgradeCapacityAction` | `capacity/actions.ts:33` | `requirePayer()` | value guard vs live catalog `:39-43` | `revalidatePath("/capacity")` `:50` | `{ok:false,error}` |
| `createAgencyJobAction` | `jobs-actions.ts:59` | `requireAgent()` | `agencyJobInputSchema` `:60` | `revalidatePath("/dashboard")` `:66` | `{ok:false,error}` |
| `updateAgencyJobAction` | `jobs-actions.ts:77` | `requireAgent()` | uuid `:78` + schema `:81` | `:88` | `{ok:false,error}` |
| `pauseAgencyJobAction` | `jobs-actions.ts:98` | `requireAgent()` | uuid `:99` | `:105` | `{ok:false,error}` |
| `closeAgencyJobAction` | `jobs-actions.ts:115` | `requireAgent()` | uuid `:116` | `:123` | `{ok:false,error}` |
| `createInviteAction` | `invite-actions.ts:64` | `requireAgent()` | `campaignSchema` + `parseInviteMeta` `:69`,`:79` | none | `{ok:false,error}` |
| `createInviteBatchAction` | `batch-invite-actions.ts:93` | `requireAgent()` | `countSchema`/`campaignSchema` `:95`,`:101` | none | `{ok:false,error}` |
| `submitKycAction` | `supply-actions.ts:39` | `requireAgent()` | `agencyKycInputSchema` `:40` | `revalidatePath("/agency/referrals")` `:47` | 3-arm union |
| `requestPayoutAction` | `supply-actions.ts:72` | `requireAgent()` | no input by design `:69-70` | `:77` | 4-arm union |

The `credits/actions.ts:27-41` comment records that `topUpAction` originally had **no** gate and a recruiter could mint credits — that hole is closed.

## 5.2 Actions with NO explicit gate (15) — authenticated, but not re-asserted

| Action | File | Auth reality | zod | revalidate/redirect | 401 handling |
|---|---|---|---|---|---|
| `updateAccountAction` | `account/actions.ts:45` | `payerFetch` cookie Bearer | `accountPatchSchema` `:36-41` | none (client `router.refresh()`) | swallowed `:68` |
| `pausePostingAction` | `postings/actions.ts:37` | cookie | `postingIdSchema` `:29` | `revalidatePath("/postings")` `:45` | swallowed `:47` |
| `resumePostingAction` | `postings/actions.ts:53` | cookie | `:29` | `:61` | swallowed `:63` |
| `topUpQuotaAction` | `postings/actions.ts:74` | cookie | `:29` | `:82` | swallowed `:90` |
| `closePostingAction` | `postings/actions.ts:101` | cookie | `:29` | `:109` | swallowed `:111` |
| `createPostingAction` | `postings/new/actions.ts:32` | cookie | `createPostingInputSchema` + `matchSelectionInputSchema` `:45`,`:63` | client `router.push` | swallowed `:74`,`:83` |
| `previewReachAction` | `postings/new/match-actions.ts:28` | cookie | `matchSelectionInputSchema` `:32` | n/a (read) | swallowed `:38` |
| `updatePostingAction` | `postings/[id]/edit/actions.ts:23` | cookie | uuid `:32` + `updatePostingInputSchema` `:35` | `revalidatePath` ×2 `:54-55` | swallowed `:57` |
| `unlockAction` | `applicants/actions.ts:33` | cookie | uuid ×2 `:37` | none | swallowed `:43` |
| `revealContactAction` | `applicants/actions.ts:53` | cookie | uuid `:56` | none | swallowed `:61` |
| `maskedResumeAction` | `applicants/actions.ts:77` | cookie | uuid ×3 `:82-87` | none | swallowed `:91` |
| `startJobPostingChatAction` | `ai/new/actions.ts:52` | cookie | none needed (empty body) | none | swallowed `:56` |
| `sendJobPostingChatMessageAction` | `ai/new/actions.ts:62` | cookie | `jobPostingChatMessageInputSchema` `:66` | none | swallowed `:74` |
| `resumeJobPostingChatAction` | `ai/new/actions.ts:83` | cookie | uuid `:86` | none | swallowed `:93` |
| `publishJobPostingChatAction` | `ai/new/actions.ts:102` | cookie | uuid `:106` | `revalidatePath("/postings")` `:111` | swallowed `:113` |

**Assessment — this is NOT a P0 authorization hole, and I want to be precise about why:**
- Authentication *is* enforced: `payer-http.ts:48-52` refuses to send the request without the httpOnly cookie, and `:61` treats the API's 401 as a hard failure. An unauthenticated caller gets nothing.
- Tenancy *is* enforced server-side: the API derives `payer_id` from `req.payer.id` and never from the body (`payer-http.ts:11-15`, `payer-job-postings.controller.ts:45-53`).
- Role authorization is not missing, because **every one of these 15 actions targets a surface both `employer` and `agent` legitimately use** (postings, applicants, unlocks, own account, AI chat). There is no `@PayerRoles`-equivalent claim being bypassed.

The genuine defects are (i) the 401→"please retry" dead end in §4, and (ii) an **inconsistent convention** — 15 of 34 actions gate first with a documented rationale (`jobs-actions.ts:16-21`, `credits/actions.ts:27-41`), 15 do not. The moment any of those 15 surfaces becomes role-scoped, the missing gate silently becomes a hole. Recommend gating all of them uniformly and mapping `isPayerUnauthorized` to `redirect("/login")` in one shared helper.

## 5.3 Deliberately ungated (4)

`requestCodeAction`, `signupAction`, `verifyCodeAction` (`login/actions.ts:32`,`:59`,`:92`) are pre-auth by definition and all three are no-enumeration by construction (`:36-37`, `:72-75`, `:98-101`). `logoutAction` (`logout-action.ts:7-10`) only clears the caller's own cookie.

## 5.4 Untested actions

Action modules with a colocated `*.test.ts`: postings, edit, credits, capacity, team, jobs-actions, invite-actions, batch-invite-actions, supply-actions, login. **Untested (6 modules / 11 actions):** `account/actions.ts`, `postings/new/actions.ts`, `postings/new/match-actions.ts`, `postings/ai/new/actions.ts` (4 actions), `postings/[id]/applicants/actions.ts` (3 actions — the entire credit-spend path), `logout-action.ts`.

---

# 6. (e) Forms, inert buttons, destructive confirmations

## 6.1 Form validation matrix

| Form | Client validation | Server validation | Submit disabled until valid |
|---|---|---|---|
| `posting-form.tsx` | full per-field + cross-field `validate()` `:87-155`, incl. `looksLikePii` on description `:150` | `createPostingInputSchema` + `matchSelectionInputSchema` `actions.ts:45`,`:63` | yes `:191-192`, `:233` |
| `edit-posting-form.tsx` | `validate()` `:40-48` | `updatePostingInputSchema` `actions.ts:35` | no (validates on submit) |
| `account-form.tsx` | `validate()` `:91-98`, focuses first invalid `:112-113` | `accountPatchSchema` `actions.ts:36-41` | yes — pristine guard `:139` |
| `agency-job-form.tsx` | present (`agency-job-form.test.tsx` covers it) | `agencyJobInputSchema` `jobs-actions.ts:60` | — |
| `kyc-panel.tsx` | `agencyKycInputSchema.safeParse` client-side `:42-51` | same schema `supply-actions.ts:40` | no (validates on submit) |
| `invite-panel.tsx` | `campaignError`/`contextError` state `:45`,`:58` | `campaignSchema` + `parseInviteMeta` `invite-actions.ts:69`,`:79` | no |
| `batch-invite-panel.tsx` | `countError`/`campaignError` `:62`,`:64` | `countSchema`/`campaignSchema` `batch-invite-actions.ts:95`,`:101` | yes `:264` |
| **`team-manager.tsx`** | **NONE** — `<Input type="email">` only, no `required`, no `validate()`, no disable-until-valid (`:54-73`) | `emailSchema` `team/actions.ts:28` | no |
| `login-form.tsx` | present (`login-form.test.tsx`) | zod `login/actions.ts:20-26` | — |

**Only `team-manager.tsx` lacks any client-side validation function.** An empty submit reaches the server and returns "Enter a valid email address." — degraded but not broken.

## 6.2 Inert buttons / affordances

No genuinely inert submit button was found — every `Button` in the app is wired to an action or a state transition. But three affordances render values that are **not** read from anywhere:

1. `account/page.tsx:83` + `:94` and `profile/page.tsx:68` + `:79` — the agency KYC cards hardcode `<Badge>Pending</Badge>` / `"Not added"` / `<Badge>Not set</Badge>`. Neither page calls `getAgencyKyc()`. A verified agency still sees "Pending".
2. `dashboard/page.tsx:106-116` — the agent "Revenue" `StatTile` renders `value="—"` and `delta="Coming soon"`, linking to the parked `/agency/revenue`. Honest, but a permanent placeholder tile in the primary stat row.
3. `agent-sections.tsx:202-216` — a second "Revenue" card, same `—`.

## 6.3 Destructive-action confirmation matrix

| Action | Confirmation | Evidence |
|---|---|---|
| Unlock a candidate (spends 1 credit) | **YES** — DS `ConfirmSpendDialog`, first unlock per row | `applicant-actions.tsx:505-511`, `:159-167` |
| Buy credit pack — **mock** mode | **YES** — `window.confirm` | `credits-panel.tsx:52-56` |
| Buy credit pack — **real** Razorpay | **NO** app-level confirm (Razorpay's own modal is the only gate) | `credits-panel.tsx:72-137` |
| Buy capacity tier (mock money) | **YES** — `window.confirm` | `capacity-panel.tsx:40-44` |
| **Close a posting** (terminal, irreversible) | **NO** | `postings-manager.tsx:185-196` — one click straight into `closePostingAction` |
| **Close an agency vacancy** (terminal) | **NO** | `agency-jobs-manager.tsx:195-203` |
| **Pause an agency vacancy** (`pause == close` per `:38`) | **NO** | `agency-jobs-manager.tsx:186-194` |
| **Remove a team member** | **NO** | `team-manager.tsx:116-124` |
| **Request a payout** (money out, mock) | **NO** | `payout-panel.tsx:65-72` → `handleRequest` `:43-58` |
| Pause / resume / top-up quota | NO (reversible / has a notice) | `postings-manager.tsx:152-184` — acceptable |

Five destructive or money-moving actions fire on a single click. `agency-jobs-manager.tsx:38` explicitly notes `pause == close` for agency jobs, so a mislabelled "Pause" button irreversibly closes a vacancy with no prompt.

---

# 7. (f) Pagination, filtering, search — every list page

| Page | List | UI pagination | UI filter/search | Backend support | Bound |
|---|---|---|---|---|---|
| `/postings` | `getPostings()` `payer-api.ts:961-964` | **none** | **none** | **`?status=` EXISTS** (`ListJobPostingsQuerySchema` `job-postings.dto.ts:183-185`, wired at `payer-job-postings.controller.ts:105-112`) but the seam **never sends it** | **UNBOUNDED** |
| `/dashboard` — postings | same `getPostings()` via `getDashboard()` `payer-api.ts:174` | fixed `.slice(0,6)` `dashboard/page.tsx:188` | none | same unused `?status=` | fetches all, renders 6 |
| `/dashboard` — recent unlocks | `getUnlocks()` `payer-api.ts:150-152` | fixed `.slice(0,5)` `dashboard/page.tsx:67` | none | `GET /payer/unlocks` → `listByPayer(payer.id)` with **no limit param** (`payer-unlocks.controller.ts:94-97`) | **UNBOUNDED** |
| `/credits` — history | `getUnlocks()` + `getCreditTopUps()` | **none** — full table `credits/page.tsx:158` | none | ledger caps at `?limit=50`, hardcoded in the seam `payer-api.ts:416`; the seam's own comment admits older top-ups age out (`:419-421`) | unlocks unbounded, ledger 50 |
| `/credits` — expiry | derived from the same 50 rows | none | none | — | 50 |
| `/postings/[id]/applicants` | `getApplicantFeed(id)` `payer-api.ts:240-261` | **none** | client-side stage tabs only (`applicant-actions.tsx:195`) — not a server filter | `GET /payer/reach/jobs/:jobId/applicants` (`payer-reach.controller.ts:63`) | **UNBOUNDED** |
| `/agency/workers` | `listAgencyWorkers()` `payer-api.ts:796-799` | none | none | backend hard cap 200, **disclosed honestly** in the UI (`agency/workers/page.tsx:16`, `:95-97`) | 200 |
| `/agency/referrals` — payouts | `listAgencyPayouts()` `payer-api.ts:889-892` | none | none | `GET /payer/agency/payouts` | **UNBOUNDED** |
| `/dashboard` — agency vacancies | `listAgencyJobs()` `payer-api.ts:558-561` | none | none | `GET /payer/agency/jobs` (`agency-jobs.controller.ts:49`) | **UNBOUNDED** |
| `/team` | `listOrgMembers()` `org-members.ts:72-75` | none | none | `GET /payer/org/members` (`payer-org-members.controller.ts:39`) | **UNBOUNDED** |
| `/plans`, `/capacity` — per-posting quota table | `getCapacity()` `payer-api.ts:454` | none | none | `GET /payer/capacity` | **UNBOUNDED** |

**Summary: 8 unbounded fetches, 2 fixed caps (50 / 200), 0 pagination controls, 0 search inputs, 0 server-side filters used.** The only filter the backend already offers (`?status=` on job postings) is unused, so an employer with 300 closed postings must scroll all of them to find an open one.

---

# 8. Additional verified findings

### 8.1 `applicantCount` is hardcoded to 0 for every posting

```ts
// apps/payer-web/src/lib/payer-api.ts:947-957
function toPostingSummary(wire) {
  return postingSummarySchema.parse({
    ...
    applicantCount: 0,   // :954  <-- literal, never from the wire
    // applicantQuota intentionally omitted  :956
  });
}
```
The frontend `jobPostingWireSchema` (`contracts.ts:771-786`) has no applicant fields, so the seam cannot receive them. **But the backend already sends them:** `payer-job-postings.controller.ts:22` defines `PayerJobPostingView = JobPostingApi & PostingStats & { disclosures_count }`, and `enrich()` (`:76-85`) merges `getPostingStats()` (`applicant_visibility_quota`, `applicants_viewed_count`, `boosted` — `posting-plans.service.ts:130-135`) plus a disclosures count onto every row of both `list()` (`:105-112`) and `getOne()` (`:115-122`).

Rendered consequences:
- `dashboard/page.tsx:205` — every posting card reads `0 applicants`.
- `postings-manager.tsx:130-131` — every row reads `0 / —` applicants.
- `postings/[id]/page.tsx:61-62` — the detail page reads `0 / —`.

An employer's primary "did anyone apply?" signal is permanently zero on all three surfaces, even when the reach feed has candidates. The applicant feed itself is fine (it uses a different endpoint), but the payer has no reason to click into it.

### 8.2 Applicant pipeline and revealed contacts are client-local — lost on refresh

`applicant-actions.tsx:26-30` states it outright: *"PIPELINE (LOCAL ONLY) … Keep, Pass, and 'Mark as contacted' are pure CLIENT transitions — NO network call, no event, nothing persisted."* Implementations: `onKeep` `:120-122`, `onPass` `:123-125`, `onReach` `:130-132`, `onContacted` `:136-138`.

Worse, the **unlock/reveal result is also local state** (`rows` `:95`, populated only by `runUnlock` `:142-155` and `onRevealContact` `:198-203`). `applicants/page.tsx:24-41` fetches only the feed and the balance — it never re-reads `getUnlocks()` to rehydrate which candidates the payer already unlocked. So after a hard refresh: the shortlist is gone, "contacted" marks are gone, and a candidate the payer **paid a credit for** shows as locked again. Re-revealing costs another round trip through `POST /payer/unlocks/:id/reveal`, which is behind an hourly disclosure cap (`payer-unlocks.controller.ts:89`).

### 8.3 AI-chat postings are published with zero match skills

The manual path refuses to create a posting without at least one match skill:
```ts
// postings/new/actions.ts:63-69
const selection = matchSelectionInputSchema.safeParse({...});
if (!selection.success) return { ok:false, error:"Pick at least one skill so workers can find this job." };
```
and publishes via `publishPostingWithMatchSkills` (`:79`).

The AI path does not. `publishJobPostingChatAction` (`ai/new/actions.ts:102-118`) calls `publishJobPostingChatSession`, which POSTs an **empty body** (`payer-api.ts:1430-1434`). `grep -n 'matchSkill\|match_skill' apps/api/src/payer-portal/job-posting-chat/*.ts` returns **nothing**. So a posting created through `/postings/ai/new` carries no match skills — exactly the state the manual action's own comment (`:60-62`) calls "would simply reach nobody". Under `MATCH_V1_ENABLED` (currently default OFF) this is the difference between a posting that reaches workers and one that reaches none, and the payer is given no signal either way.

### 8.4 `/postings/[id]/applicants` skips the uuid guard its three siblings have

Three sibling dynamic routes fail closed on a non-uuid segment *before* aiming the server-held Bearer at the authed API path, with an explicit rationale:
- `postings/[id]/page.tsx:36-37`
- `postings/[id]/edit/page.tsx:40-42` — *"a percent-encoded path could otherwise aim the server-held Bearer at another route"*
- `agency/jobs/[jobId]/page.tsx:34-35`

`applicants/page.tsx:19` destructures `id` and passes it straight to `getApplicantFeed(id)` (`:28`), which interpolates it raw: `payerFetch(\`/payer/reach/jobs/${jobId}/applicants\`)` (`payer-api.ts:243`). The same page also omits `requirePayer()` entirely (relying on the layout). The Server Actions on that page *do* validate (`applicants/actions.ts:37`), so the exposure is limited to the page read — but it is the one dynamic route that skips a guard its siblings document as necessary.

### 8.5 Team mutations never revalidate

`team/actions.ts` imports no `revalidatePath`/`revalidateTag`, and `team-manager.tsx` never calls `router.refresh()` (`:32-48`). `members` is a server prop from `team/page.tsx:18`. **After inviting or removing a member the table does not change** — the user sees "Member removed." while the row is still there. Contrast `jobs-actions.ts:66/88/105/123`, `supply-actions.ts:47/77`, `capacity/actions.ts:50`, `postings/actions.ts:45/61/82/109`, all of which revalidate.

### 8.6 `upgradeCapacityAction` revalidates the wrong path

`capacity/actions.ts:50` calls `revalidatePath("/capacity")`. But `CapacityPanel` is rendered on **both** `/capacity` (`capacity/page.tsx:122`) and `/plans` (`plans/page.tsx:120`). Buying capacity from `/plans` — the route that is actually in the nav — leaves that page's `getCapacity()` result stale. `capacity-panel.tsx:54` calls `router.refresh()`, which papers over it, but the revalidation itself targets the wrong route.

### 8.7 Agency portal flag gate is applied inconsistently

`agencyFlags().agencyPortalEnabled` (`config.ts:86`, default ON) fail-closes 4 of 6 agency routes:
- Checked: `agency/workers/page.tsx:52`, `agency/revenue/page.tsx:13`, `agency/qr/page.tsx:25`, `agency/bulk-upload/page.tsx:24`, and `agent-sections.tsx:61`.
- **Not checked:** `agency/referrals/page.tsx` (only `requireAgent()` at `:47`) and `agency/jobs/[jobId]/page.tsx` (only `requireAgent()` at `:32`).

Flipping `NEXT_PUBLIC_ENABLE_AGENCY_PORTAL=false` would leave the referrals page (with its invite mint, batch mint, funnel and payout panels) and every agency job detail page live.

### 8.8 Route test coverage

**Routes with a page-level test (10):** `/dashboard`, `/account`, `/credits`, `/capacity`, `/agency/workers`, `/agency/referrals` (parked-state only), `/agency/dashboard`, `/login`, `/i/[code]`, `/postings/[id]/applicants`.

**Routes with NO page-level test (15):** `/`, `/profile`, `/postings`, `/postings/new`, `/postings/ai/new`, `/postings/[id]`, `/postings/[id]/edit`, `/plans`, `/team`, `/team/accept`, `/agency/revenue`, `/agency/qr`, `/agency/bulk-upload`, `/agency/jobs/[jobId]`, `/i/[code]/desktop`.

83 test files total, all `renderToStaticMarkup`-based SSR/unit tests. No Playwright/Cypress/testing-library anywhere; `apps/payer-web` has no coverage thresholds and is not in the `e2e` job's path filter.

---

# 9. Priority ordering

**P0** — PAY-RT-01 (`/credits` + `/team` dead), PAY-RT-02 (6 dead `/credits` CTAs incl. every Buy button), PAY-RT-03 (`applicantCount` hardcoded 0).

**P1** — PAY-RT-04 (401 dead-end in 15 actions), PAY-RT-05 (pipeline + reveal lost on refresh), PAY-RT-06 (AI postings have no match skills), PAY-RT-07 (5 unconfirmed destructive actions), PAY-RT-08 (team mutations never revalidate), PAY-RT-09 (no pagination/filter on 10 lists), PAY-RT-10 (11 untested actions incl. the whole credit-spend path).

**P2** — PAY-RT-11 (no per-route loading/error), PAY-RT-12 (applicants route skips the uuid guard), PAY-RT-13 (`/profile` duplicates `/account`), PAY-RT-14 (agency flag gate inconsistent), PAY-RT-15 (hardcoded KYC badges), PAY-RT-16 (`/capacity` orphaned), PAY-RT-17 (`revalidatePath("/capacity")` misses `/plans`), PAY-RT-18 (`team/page.tsx` unguarded read), PAY-RT-19 (`team-manager` has no client validation), PAY-RT-20 (15 routes with no page test).

**P3** — PAY-RT-21 (real Razorpay Buy has no app-level confirm).